// xcaf-step-planner – XCAF structure scanner and CAD chunk planner.
//
// Reads a STEP file into an XCAF document, scans the assembly tree without meshing,
// counts leaves / faces / solids, detects shared TShape prototypes (mesh-reuse
// awareness), and emits a large-model-plan.json describing how to split the model
// into N parallel conversion chunks.
//
// Usage:
//   xcaf-step-planner input.step output-dir [--target-chunks N] [--max-leaves M]
//
// The tool writes:
//   <output-dir>/large-model-plan.json
//
// It does NOT mesh, tessellate, write GLB, or start any jobs.

#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRep_TFace.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------
static constexpr double kDefaultFileSizeThresholdBytes = 80.0 * 1024.0 * 1024.0;
static constexpr int kDefaultLeafThreshold = 2000;
static constexpr int kDefaultFaceThreshold = 50000;
static constexpr int kDefaultTargetChunks = 4;
static constexpr int kDefaultMaxLeavesPerChunk = 750;

// Parallelism cap for EliteDesk
static constexpr int kMaxRecommendedParallelism = 3;

// ---------------------------------------------------------------------------
// Helpers duplicated from main.cpp (kept independent for safety)
// ---------------------------------------------------------------------------

static std::string labelEntry(const TDF_Label& label) {
    TCollection_AsciiString entry;
    TDF_Tool::Entry(label, entry);
    return entry.ToCString();
}

static std::string extendedToUtf8(const TCollection_ExtendedString& value) {
    TCollection_AsciiString ascii(value, '?');
    return ascii.ToCString();
}

static std::string labelName(const TDF_Label& label) {
    Handle(TDataStd_Name) nameAttr;
    if (label.FindAttribute(TDataStd_Name::GetID(), nameAttr)) {
        return extendedToUtf8(nameAttr->Get());
    }
    return {};
}

static bool isRawLabelName(const std::string& value) {
    if (value.empty()) return true;
    if (value.rfind("=>[", 0) == 0 && value.back() == ']') return true;
    std::string upper = value;
    for (auto& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (upper == "DOCUMENT" || upper == "COMPOUND" || upper == "COMPSOLID" ||
        upper == "SOLID" || upper == "SHELL" || upper == "FACE" || upper == "SHAPE" ||
        upper == "OPEN CASCADE STEP TRANSLATOR") return true;
    if (upper.rfind("BREP_REP_", 0) == 0 || upper.rfind("SHELL_REP_", 0) == 0) return true;
    if (upper.rfind("BREP_", 0) == 0 && upper.size() > 5 &&
        std::all_of(upper.begin() + 5, upper.end(), [](unsigned char c) { return std::isdigit(c); }))
        return true;
    return std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isdigit(c) || c == ':';
    });
}

static std::string normalizeDisplayWhitespace(const std::string& value) {
    std::string result;
    bool pendingSpace = false;
    for (const unsigned char c : value) {
        if (c == '\r' || c == '\n') continue;
        if (std::isspace(c)) {
            pendingSpace = !result.empty();
        } else {
            if (pendingSpace) result.push_back(' ');
            result.push_back(static_cast<char>(c));
            pendingSpace = false;
        }
    }
    return result;
}

static std::string readableLabelName(const TDF_Label& label) {
    const std::string value = label.IsNull() ? "" : labelName(label);
    return isRawLabelName(value) ? "" : normalizeDisplayWhitespace(value);
}

static std::string jsonEscape(const std::string& value) {
    std::ostringstream out;
    for (const unsigned char c : value) {
        switch (c) {
            case '"':  out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b";  break;
            case '\f': out << "\\f";  break;
            case '\n': out << "\\n";  break;
            case '\r': out << "\\r";  break;
            case '\t': out << "\\t";  break;
            default:
                if (c < 0x20) {
                    out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
                } else {
                    out << c;
                }
        }
    }
    return out.str();
}

static std::string nowIso() {
    const auto now = std::chrono::system_clock::now();
    const auto t = std::chrono::system_clock::to_time_t(now);
    std::ostringstream ss;
    ss << std::put_time(std::gmtime(&t), "%Y-%m-%dT%H:%M:%SZ");
    return ss.str();
}

// ---------------------------------------------------------------------------
// PlannerNode – represents one XCAF label/subtree during scanning
// ---------------------------------------------------------------------------
struct PlannerNode {
    std::string labelPath;
    std::string name;            // readable display name (may be empty)
    std::string parentPath;
    int depth = 0;

    // Topology counts (over the full subtree, including references)
    int leafCount  = 0;
    int faceCount  = 0;
    int solidCount = 0;

    // Prototype tracking (unique TShape* seen at leaves under this subtree)
    std::set<void*> uniquePrototypes;     // unique TShape* pointers in this subtree
    int totalLeafInstances = 0;           // total leaf instances (may repeat prototypes)

    // Bbox
    double bboxXmin = std::numeric_limits<double>::max();
    double bboxYmin = std::numeric_limits<double>::max();
    double bboxZmin = std::numeric_limits<double>::max();
    double bboxXmax = std::numeric_limits<double>::lowest();
    double bboxYmax = std::numeric_limits<double>::lowest();
    double bboxZmax = std::numeric_limits<double>::lowest();
    bool bboxValid = false;

    // Work scores
    double naiveWorkScore = 0.0;   // leaves * 1.0 + faces * 0.3 + solids * 2.0
    double reuseAwareScore = 0.0;  // based on uniquePrototypes instead of totalLeafInstances

    bool isAssembly = false;
    std::vector<std::string> childPaths;    // direct children label paths

    void mergeBbox(const PlannerNode& child) {
        if (!child.bboxValid) return;
        bboxXmin = std::min(bboxXmin, child.bboxXmin);
        bboxYmin = std::min(bboxYmin, child.bboxYmin);
        bboxZmin = std::min(bboxZmin, child.bboxZmin);
        bboxXmax = std::max(bboxXmax, child.bboxXmax);
        bboxYmax = std::max(bboxYmax, child.bboxYmax);
        bboxZmax = std::max(bboxZmax, child.bboxZmax);
        if (child.bboxValid) bboxValid = true;
    }
};

// ---------------------------------------------------------------------------
// ChunkPlan – one planned output chunk
// ---------------------------------------------------------------------------
struct ChunkPlan {
    int index = 0;
    std::string name;
    std::string parentLabelPath;
    std::vector<std::string> rootLabelPaths;
    std::vector<std::string> displayNames;   // readable names of included roots

    int leafCount  = 0;
    int faceCount  = 0;
    int solidCount = 0;

    // Prototype/reuse tracking
    std::set<void*> uniquePrototypes;
    int totalLeafInstances = 0;   // raw leaf count summed over roots (counting duplicates)

    double naiveWorkScore = 0.0;
    double naiveWorkPercent = 0.0;
    double reuseAwareScore = 0.0;
    double reuseAwarePercent = 0.0;

    // Bbox
    double bboxXmin = std::numeric_limits<double>::max();
    double bboxYmin = std::numeric_limits<double>::max();
    double bboxZmin = std::numeric_limits<double>::max();
    double bboxXmax = std::numeric_limits<double>::lowest();
    double bboxYmax = std::numeric_limits<double>::lowest();
    double bboxZmax = std::numeric_limits<double>::lowest();
    bool bboxValid = false;

    std::string extractionStrategy;  // "single_subtree" | "root_child_group" | "multiple_label_paths" | "fallback"
    std::vector<std::string> warnings;
};

// ---------------------------------------------------------------------------
// Planner result
// ---------------------------------------------------------------------------
struct PlannerResult {
    std::string inputPath;
    std::uintmax_t fileSizeBytes = 0;
    int freeShapeCount = 0;
    int totalAssemblyCount = 0;
    int totalLeafCount = 0;
    int totalSolidCount = 0;
    int totalFaceCount = 0;
    int totalUniquePrototypes = 0;       // unique TShape* across the whole model
    int totalLeafInstances = 0;          // total leaf instances (counting repeats)

    double bboxXmin = 0, bboxYmin = 0, bboxZmin = 0;
    double bboxXmax = 0, bboxYmax = 0, bboxZmax = 0;
    bool bboxValid = false;

    double naiveComplexityScore = 0.0;
    double reuseAwareComplexityScore = 0.0;
    double reuseRatio = 0.0;             // unique / total – approaches 1 if no reuse

    bool chunkingEnabled = false;
    int targetChunks = kDefaultTargetChunks;
    int recommendedParallelism = 2;
    std::vector<std::string> triggerReasons;

    std::vector<ChunkPlan> chunks;

    // Cross-chunk prototype sharing warnings
    std::vector<std::string> plannerWarnings;

    double plannerRuntimeSeconds = 0.0;
};

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------
struct ScanContext {
    const Handle(XCAFDoc_ShapeTool)& shapeTool;
    std::map<std::string, PlannerNode>& nodes;
    std::set<std::string>& assemblies;  // paths of labels that are assemblies
};

// ---------------------------------------------------------------------------
// countFacesAndSolids – topology count on a resolved shape without meshing
// ---------------------------------------------------------------------------
static void countFacesAndSolids(const TopoDS_Shape& shape, int& faces, int& solids) {
    faces = 0;
    solids = 0;
    std::set<const TopoDS_TShape*> seenFaces, seenSolids;
    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
        const TopoDS_Shape& f = exp.Current();
        if (seenFaces.insert(f.TShape().get()).second) {
            ++faces;
        }
    }
    for (TopExp_Explorer exp(shape, TopAbs_SOLID); exp.More(); exp.Next()) {
        const TopoDS_Shape& s = exp.Current();
        if (seenSolids.insert(s.TShape().get()).second) {
            ++solids;
        }
    }
}

// ---------------------------------------------------------------------------
// resolveShape – get the actual shape for a label, following references
// ---------------------------------------------------------------------------
static TopoDS_Shape resolveShape(const Handle(XCAFDoc_ShapeTool)& shapeTool,
                                  const TDF_Label& label) {
    TopoDS_Shape shape = shapeTool->GetShape(label);
    if (shape.IsNull() && shapeTool->IsReference(label)) {
        TDF_Label referred;
        if (shapeTool->GetReferredShape(label, referred)) {
            shape = shapeTool->GetShape(referred);
        }
    }
    return shape;
}

// ---------------------------------------------------------------------------
// collectLeafPrototypes – gather unique TShape* at leaves of a label subtree
// Used to detect mesh-reuse potential.
// ---------------------------------------------------------------------------
static void collectLeafPrototypes(
        const Handle(XCAFDoc_ShapeTool)& shapeTool,
        const TDF_Label& label,
        std::set<void*>& uniquePrototypes,
        int& totalInstances,
        std::set<std::string>& visited) {

    const std::string path = labelEntry(label);
    if (!visited.insert(path).second) return;

    TDF_LabelSequence children;
    bool hasChildren = shapeTool->GetComponents(label, children, Standard_False);

    if (!hasChildren && shapeTool->IsReference(label)) {
        TDF_Label referred;
        if (shapeTool->GetReferredShape(label, referred)) {
            hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
        }
    }

    if (hasChildren && children.Length() > 0) {
        for (Standard_Integer i = 1; i <= children.Length(); ++i) {
            collectLeafPrototypes(shapeTool, children.Value(i), uniquePrototypes, totalInstances, visited);
        }
    } else {
        // Leaf: record TShape pointer
        TopoDS_Shape shape = resolveShape(shapeTool, label);
        if (!shape.IsNull() && !shape.TShape().IsNull()) {
            uniquePrototypes.insert(shape.TShape().get());
        }
        ++totalInstances;
    }
}

// ---------------------------------------------------------------------------
// scanSubtree – recursively scan an XCAF subtree, fill PlannerNode entries
// ---------------------------------------------------------------------------
static PlannerNode scanSubtree(
        const Handle(XCAFDoc_ShapeTool)& shapeTool,
        const TDF_Label& label,
        const std::string& parentPath,
        int depth,
        std::map<std::string, PlannerNode>& nodeMap) {

    const std::string path = labelEntry(label);
    const std::string name = readableLabelName(label);

    PlannerNode node;
    node.labelPath = path;
    node.name = name;
    node.parentPath = parentPath;
    node.depth = depth;

    TDF_LabelSequence children;
    bool hasChildren = shapeTool->GetComponents(label, children, Standard_False);
    TDF_Label referred = label;
    if (!hasChildren && shapeTool->IsReference(label)) {
        if (shapeTool->GetReferredShape(label, referred)) {
            hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
        }
    }

    if (hasChildren && children.Length() > 0) {
        node.isAssembly = true;
        for (Standard_Integer i = 1; i <= children.Length(); ++i) {
            const TDF_Label& child = children.Value(i);
            const std::string childPath = labelEntry(child);
            node.childPaths.push_back(childPath);

            PlannerNode childNode = scanSubtree(shapeTool, child, path, depth + 1, nodeMap);

            // Aggregate from child
            node.leafCount  += childNode.leafCount;
            node.faceCount  += childNode.faceCount;
            node.solidCount += childNode.solidCount;
            node.totalLeafInstances += childNode.totalLeafInstances;
            for (void* ptr : childNode.uniquePrototypes) {
                node.uniquePrototypes.insert(ptr);
            }
            node.mergeBbox(childNode);
        }
    } else {
        // Leaf node
        node.isAssembly = false;
        node.leafCount = 1;
        node.totalLeafInstances = 1;

        // Topology scan
        TopoDS_Shape shape = resolveShape(shapeTool, label);
        if (!shape.IsNull()) {
            int faces = 0, solids = 0;
            countFacesAndSolids(shape, faces, solids);
            node.faceCount  = faces;
            node.solidCount = solids;

            // Record prototype
            if (!shape.TShape().IsNull()) {
                node.uniquePrototypes.insert(shape.TShape().get());
            }

            // Bounding box (no mesh needed for raw geometry)
            Bnd_Box box;
            BRepBndLib::Add(shape, box);
            if (!box.IsVoid()) {
                Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
                box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
                node.bboxXmin = xmin; node.bboxYmin = ymin; node.bboxZmin = zmin;
                node.bboxXmax = xmax; node.bboxYmax = ymax; node.bboxZmax = zmax;
                node.bboxValid = true;
            }
        }
    }

    // Work scores
    // Naive: every leaf instance counted
    node.naiveWorkScore = node.leafCount * 1.0 + node.faceCount * 0.3 + node.solidCount * 2.0;

    // Reuse-aware: unique prototypes + instance overhead (small)
    // Unique prototype work + a fraction for the extra transform/material setup per instance
    const int uniqueP = static_cast<int>(node.uniquePrototypes.size());
    const int extraInstances = std::max(0, node.totalLeafInstances - uniqueP);
    node.reuseAwareScore = uniqueP * 1.0 + node.faceCount * 0.3 + node.solidCount * 2.0 +
                           extraInstances * 0.1;  // 10% overhead per reused instance

    nodeMap[path] = node;
    return node;
}

// ---------------------------------------------------------------------------
// Recursive chunk splitting: takes a set of candidate PlannerNode paths and
// recursively splits any that exceed maxLeavesPerChunk.
// Returns a flat list of "chunk seeds" (label paths) to bin-pack.
// ---------------------------------------------------------------------------
static void flattenCandidates(
        const Handle(XCAFDoc_ShapeTool)& shapeTool,
        const std::string& candidatePath,
        int maxLeavesPerChunk,
        const std::map<std::string, PlannerNode>& nodeMap,
        std::vector<std::string>& seeds,
        std::vector<std::string>& warnings) {

    auto it = nodeMap.find(candidatePath);
    if (it == nodeMap.end()) {
        seeds.push_back(candidatePath);
        return;
    }
    const PlannerNode& node = it->second;

    // If this node is small enough, keep as one seed
    if (node.leafCount <= maxLeavesPerChunk) {
        seeds.push_back(candidatePath);
        return;
    }

    // Node is too big — can we split into children?
    if (!node.isAssembly || node.childPaths.empty()) {
        // Cannot split further (it's a single giant leaf or unresolvable assembly)
        seeds.push_back(candidatePath);
        warnings.push_back("huge_unsplittable_subtree: " + candidatePath + " name=" + node.name +
                           " leaves=" + std::to_string(node.leafCount));
        return;
    }

    // Recurse into children
    for (const std::string& childPath : node.childPaths) {
        flattenCandidates(shapeTool, childPath, maxLeavesPerChunk, nodeMap, seeds, warnings);
    }
}

// ---------------------------------------------------------------------------
// Greedy bin-packing: assign seeds to N chunks minimising work imbalance.
// Uses a min-heap of (currentScore, chunkIndex).
// ---------------------------------------------------------------------------
static std::vector<ChunkPlan> packChunks(
        int targetChunks,
        const std::vector<std::string>& seeds,
        const std::map<std::string, PlannerNode>& nodeMap,
        std::vector<std::string>& warnings) {

    const int N = std::max(1, std::min(targetChunks, static_cast<int>(seeds.size())));
    std::vector<ChunkPlan> chunks(N);
    for (int i = 0; i < N; ++i) {
        chunks[i].index = i;
        chunks[i].extractionStrategy = "root_child_group";
    }

    // Sort seeds by reuseAwareScore descending (heaviest first)
    std::vector<std::string> sorted = seeds;
    std::sort(sorted.begin(), sorted.end(), [&](const std::string& a, const std::string& b) {
        const auto ia = nodeMap.find(a);
        const auto ib = nodeMap.find(b);
        double sa = (ia != nodeMap.end()) ? ia->second.reuseAwareScore : 0.0;
        double sb = (ib != nodeMap.end()) ? ib->second.reuseAwareScore : 0.0;
        return sa > sb;
    });

    // Min-heap: (current chunk score, chunk index)
    using ChunkEntry = std::pair<double, int>;
    std::priority_queue<ChunkEntry, std::vector<ChunkEntry>, std::greater<ChunkEntry>> heap;
    for (int i = 0; i < N; ++i) {
        heap.push({0.0, i});
    }

    for (const std::string& seed : sorted) {
        auto [currentScore, chunkIdx] = heap.top();
        heap.pop();

        const auto it = nodeMap.find(seed);
        if (it != nodeMap.end()) {
            const PlannerNode& node = it->second;
            ChunkPlan& chunk = chunks[chunkIdx];

            chunk.rootLabelPaths.push_back(seed);
            if (!node.name.empty()) {
                chunk.displayNames.push_back(node.name);
            }
            chunk.leafCount  += node.leafCount;
            chunk.faceCount  += node.faceCount;
            chunk.solidCount += node.solidCount;
            chunk.totalLeafInstances += node.totalLeafInstances;
            for (void* ptr : node.uniquePrototypes) {
                chunk.uniquePrototypes.insert(ptr);
            }
            chunk.naiveWorkScore += node.naiveWorkScore;
            chunk.reuseAwareScore += node.reuseAwareScore;

            // Merge bbox
            if (node.bboxValid) {
                chunk.bboxXmin = std::min(chunk.bboxXmin, node.bboxXmin);
                chunk.bboxYmin = std::min(chunk.bboxYmin, node.bboxYmin);
                chunk.bboxZmin = std::min(chunk.bboxZmin, node.bboxZmin);
                chunk.bboxXmax = std::max(chunk.bboxXmax, node.bboxXmax);
                chunk.bboxYmax = std::max(chunk.bboxYmax, node.bboxYmax);
                chunk.bboxZmax = std::max(chunk.bboxZmax, node.bboxZmax);
                chunk.bboxValid = true;
            }

            heap.push({chunk.reuseAwareScore, chunkIdx});
        }
    }

    // Warn on very unbalanced chunks (largest > 2× smallest non-empty)
    double maxScore = 0.0, minScore = std::numeric_limits<double>::max();
    for (const auto& chunk : chunks) {
        if (!chunk.rootLabelPaths.empty()) {
            maxScore = std::max(maxScore, chunk.reuseAwareScore);
            minScore = std::min(minScore, chunk.reuseAwareScore);
        }
    }
    if (minScore > 0.0 && maxScore > 2.0 * minScore) {
        warnings.push_back("very_unbalanced_chunks: max_score=" + std::to_string(static_cast<int>(maxScore)) +
                           " min_score=" + std::to_string(static_cast<int>(minScore)) +
                           " ratio=" + std::to_string(maxScore / minScore).substr(0, 4));
    }

    return chunks;
}

// ---------------------------------------------------------------------------
// Cross-chunk prototype sharing analysis
// Detects how many unique prototypes appear in more than one chunk —
// those would be re-tessellated in each chunk, losing mesh-reuse benefit.
// ---------------------------------------------------------------------------
static void analyzePrototypeSharingAcrossChunks(
        const std::vector<ChunkPlan>& chunks,
        std::vector<std::string>& warnings) {

    // Count how many chunks each prototype appears in
    std::map<void*, int> prototypeChunkCount;
    for (const auto& chunk : chunks) {
        for (void* ptr : chunk.uniquePrototypes) {
            prototypeChunkCount[ptr]++;
        }
    }

    int sharedPrototypes = 0;
    for (const auto& [ptr, count] : prototypeChunkCount) {
        if (count > 1) ++sharedPrototypes;
    }

    if (sharedPrototypes > 0) {
        int totalPrototypes = static_cast<int>(prototypeChunkCount.size());
        double sharePct = totalPrototypes > 0 ?
            100.0 * sharedPrototypes / totalPrototypes : 0.0;
        std::ostringstream ss;
        ss << "cross_chunk_prototype_sharing: " << sharedPrototypes << " of " << totalPrototypes
           << " unique prototypes (" << std::fixed << std::setprecision(1) << sharePct
           << "%) appear in multiple chunks – mesh-reuse benefit partially lost across chunk boundaries";
        warnings.push_back(ss.str());
    }
}

// ---------------------------------------------------------------------------
// Finalise chunk names and extraction strategies
// ---------------------------------------------------------------------------
static void finaliseChunks(std::vector<ChunkPlan>& chunks,
                            double totalNaive, double totalReuseAware) {
    for (auto& chunk : chunks) {
        // Name
        std::string baseName;
        if (!chunk.displayNames.empty()) {
            baseName = chunk.displayNames[0];
            // Truncate long names
            if (baseName.size() > 24) {
                baseName = baseName.substr(0, 24);
            }
            // Replace spaces
            for (auto& c : baseName) {
                if (c == ' ') c = '_';
            }
        } else {
            baseName = "group";
        }
        chunk.name = "chunk_" + std::to_string(chunk.index) + "_" + baseName;

        // Percentages
        if (totalNaive > 0.0)
            chunk.naiveWorkPercent = 100.0 * chunk.naiveWorkScore / totalNaive;
        if (totalReuseAware > 0.0)
            chunk.reuseAwarePercent = 100.0 * chunk.reuseAwareScore / totalReuseAware;

        // Extraction strategy
        if (chunk.rootLabelPaths.size() == 1) {
            chunk.extractionStrategy = "single_subtree";
        } else if (!chunk.rootLabelPaths.empty()) {
            chunk.extractionStrategy = "multiple_label_paths";
        } else {
            chunk.extractionStrategy = "fallback";
            chunk.warnings.push_back("empty_chunk: no label paths assigned");
        }
    }
}

// ---------------------------------------------------------------------------
// JSON writer for large-model-plan.json
// ---------------------------------------------------------------------------
static void writePlan(const std::filesystem::path& outputPath,
                      const PlannerResult& result) {
    std::ofstream out(outputPath);
    if (!out) {
        throw std::runtime_error("Cannot open output file: " + outputPath.string());
    }

    auto writeStr = [&](const std::string& s) {
        out << '"' << jsonEscape(s) << '"';
    };

    auto writeBbox = [&](double xmin, double ymin, double zmin,
                          double xmax, double ymax, double zmax, bool valid) {
        if (valid) {
            out << "[" << xmin << ", " << ymin << ", " << zmin
                << ", " << xmax << ", " << ymax << ", " << zmax << "]";
        } else {
            out << "null";
        }
    };

    auto writeStringArray = [&](const std::vector<std::string>& arr) {
        out << "[";
        for (size_t i = 0; i < arr.size(); ++i) {
            if (i > 0) out << ", ";
            writeStr(arr[i]);
        }
        out << "]";
    };

    out << std::fixed << std::setprecision(4);

    out << "{\n";
    out << "  \"planner_version\": \"1.0.0\",\n";
    out << "  \"generated_at\": "; writeStr(nowIso()); out << ",\n";
    out << "  \"planner_runtime_seconds\": " << result.plannerRuntimeSeconds << ",\n";

    // Input
    out << "  \"input\": {\n";
    out << "    \"file_path\": "; writeStr(result.inputPath); out << ",\n";
    out << "    \"file_size_bytes\": " << result.fileSizeBytes << ",\n";
    out << "    \"file_size_mb\": " << std::setprecision(2)
        << (result.fileSizeBytes / (1024.0 * 1024.0)) << "\n";
    out << "  },\n";

    // Model summary
    out << "  \"model_summary\": {\n";
    out << "    \"free_shape_count\": " << result.freeShapeCount << ",\n";
    out << "    \"total_assembly_component_count\": " << result.totalAssemblyCount << ",\n";
    out << "    \"total_leaf_shape_count\": " << result.totalLeafCount << ",\n";
    out << "    \"total_leaf_instances\": " << result.totalLeafInstances << ",\n";
    out << "    \"total_unique_prototypes\": " << result.totalUniquePrototypes << ",\n";
    out << "    \"reuse_ratio\": " << std::setprecision(4) << result.reuseRatio << ",\n";
    out << "    \"total_solid_count\": " << result.totalSolidCount << ",\n";
    out << "    \"total_face_count\": " << result.totalFaceCount << ",\n";
    out << "    \"total_bbox\": ";
    writeBbox(result.bboxXmin, result.bboxYmin, result.bboxZmin,
              result.bboxXmax, result.bboxYmax, result.bboxZmax, result.bboxValid);
    out << ",\n";
    out << "    \"naive_complexity_score\": " << std::setprecision(1) << result.naiveComplexityScore << ",\n";
    out << "    \"reuse_aware_complexity_score\": " << result.reuseAwareComplexityScore << "\n";
    out << "  },\n";

    // Chunking recommendation
    out << "  \"chunking_recommendation\": {\n";
    out << "    \"chunking_enabled\": " << (result.chunkingEnabled ? "true" : "false") << ",\n";
    out << "    \"target_chunks\": " << result.targetChunks << ",\n";
    out << "    \"recommended_parallelism\": " << result.recommendedParallelism << ",\n";
    out << "    \"chunk_trigger_reasons\": ";
    writeStringArray(result.triggerReasons);
    out << "\n";
    out << "  },\n";

    // Chunks
    out << "  \"chunks\": [\n";
    for (size_t ci = 0; ci < result.chunks.size(); ++ci) {
        const auto& chunk = result.chunks[ci];
        out << "    {\n";
        out << "      \"chunk_index\": " << chunk.index << ",\n";
        out << "      \"chunk_name\": "; writeStr(chunk.name); out << ",\n";
        out << "      \"parent_label_path\": "; writeStr(chunk.parentLabelPath); out << ",\n";
        out << "      \"root_label_paths\": ";
        writeStringArray(chunk.rootLabelPaths);
        out << ",\n";
        out << "      \"display_names\": ";
        writeStringArray(chunk.displayNames);
        out << ",\n";
        out << "      \"leaf_count\": " << chunk.leafCount << ",\n";
        out << "      \"solid_count\": " << chunk.solidCount << ",\n";
        out << "      \"face_count\": " << chunk.faceCount << ",\n";
        out << "      \"total_leaf_instances\": " << chunk.totalLeafInstances << ",\n";
        out << "      \"unique_prototypes\": " << static_cast<int>(chunk.uniquePrototypes.size()) << ",\n";
        out << "      \"bbox\": ";
        writeBbox(chunk.bboxXmin, chunk.bboxYmin, chunk.bboxZmin,
                  chunk.bboxXmax, chunk.bboxYmax, chunk.bboxZmax, chunk.bboxValid);
        out << ",\n";
        out << "      \"naive_work_score\": " << std::setprecision(1) << chunk.naiveWorkScore << ",\n";
        out << "      \"naive_work_percent\": " << std::setprecision(2) << chunk.naiveWorkPercent << ",\n";
        out << "      \"reuse_aware_work_score\": " << std::setprecision(1) << chunk.reuseAwareScore << ",\n";
        out << "      \"reuse_aware_work_percent\": " << std::setprecision(2) << chunk.reuseAwarePercent << ",\n";
        out << "      \"extraction_strategy\": "; writeStr(chunk.extractionStrategy); out << ",\n";
        out << "      \"warnings\": ";
        writeStringArray(chunk.warnings);
        out << "\n";
        out << "    }";
        if (ci + 1 < result.chunks.size()) out << ",";
        out << "\n";
    }
    out << "  ],\n";

    // Planner warnings
    out << "  \"planner_warnings\": ";
    writeStringArray(result.plannerWarnings);
    out << "\n";

    out << "}\n";
}

// ---------------------------------------------------------------------------
// printSummary – human-readable stdout summary
// ---------------------------------------------------------------------------
static void printSummary(const PlannerResult& result) {
    const std::string sep(60, '=');
    std::cout << "\n" << sep << "\n";
    std::cout << "  XCAF Chunk Planner Summary\n";
    std::cout << sep << "\n";

    {
        std::ostringstream ssMb;
        ssMb << std::fixed << std::setprecision(1) << (result.fileSizeBytes / (1024.0 * 1024.0)) << " MB";
        std::cout << "Input:          " << result.inputPath << " (" << ssMb.str() << ")\n";
    }
    std::cout << "Free shapes:    " << result.freeShapeCount << "\n";
    std::cout << "Assemblies:     " << result.totalAssemblyCount << "\n";
    std::cout << "Leaf instances: " << result.totalLeafInstances << "\n";
    std::cout << "Unique proto:   " << result.totalUniquePrototypes
              << " (reuse ratio " << std::fixed << std::setprecision(3) << result.reuseRatio << ")\n";
    std::cout << "Total faces:    " << result.totalFaceCount << "\n";
    std::cout << "Total solids:   " << result.totalSolidCount << "\n";
    std::cout << "Naive score:    " << std::setprecision(1) << result.naiveComplexityScore << "\n";
    std::cout << "Reuse score:    " << result.reuseAwareComplexityScore << "\n";
    std::cout << "\n";

    if (result.chunkingEnabled) {
        std::cout << "Chunking:       RECOMMENDED\n";
        std::cout << "Triggers:       ";
        for (size_t i = 0; i < result.triggerReasons.size(); ++i) {
            if (i > 0) std::cout << ", ";
            std::cout << result.triggerReasons[i];
        }
        std::cout << "\n";
        std::cout << "Target chunks:  " << result.targetChunks << "\n";
        std::cout << "Parallelism:    " << result.recommendedParallelism << " parallel jobs\n";
        std::cout << "\nChunk breakdown:\n";
        for (const auto& chunk : result.chunks) {
            if (chunk.rootLabelPaths.empty()) continue;
            std::cout << "  chunk_" << chunk.index
                      << "  leaves=" << chunk.leafCount
                      << "  faces=" << chunk.faceCount
                      << "  proto=" << static_cast<int>(chunk.uniquePrototypes.size())
                      << "  naive=" << std::setprecision(0) << chunk.naiveWorkScore
                      << " (" << std::setprecision(1) << chunk.naiveWorkPercent << "%)"
                      << "  reuse=" << std::setprecision(0) << chunk.reuseAwareScore
                      << " (" << std::setprecision(1) << chunk.reuseAwarePercent << "%)\n";
        }
    } else {
        std::cout << "Chunking:       NOT recommended (model is below thresholds)\n";
    }

    if (!result.plannerWarnings.empty()) {
        std::cout << "\nWarnings (" << result.plannerWarnings.size() << "):\n";
        for (const auto& w : result.plannerWarnings) {
            std::cout << "  [WARN] " << w << "\n";
        }
    } else {
        std::cout << "\nWarnings: none\n";
    }

    std::cout << "\nPlanner runtime: " << std::fixed << std::setprecision(1)
              << result.plannerRuntimeSeconds << " s\n";
    std::cout << sep << "\n\n";
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------
struct PlannerArgs {
    std::string inputPath;
    std::string outputDir;
    int targetChunks = kDefaultTargetChunks;
    int maxLeavesPerChunk = kDefaultMaxLeavesPerChunk;
};

static PlannerArgs parseArgs(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0]
                  << " input.step output-dir"
                  << " [--target-chunks N]"
                  << " [--max-leaves M]\n";
        std::exit(1);
    }
    PlannerArgs args;
    args.inputPath  = argv[1];
    args.outputDir  = argv[2];

    for (int i = 3; i < argc; ++i) {
        const std::string arg = argv[i];
        if ((arg == "--target-chunks" || arg == "--target_chunks") && i + 1 < argc) {
            args.targetChunks = std::max(1, std::stoi(argv[++i]));
        } else if ((arg == "--max-leaves" || arg == "--max-leaves-per-chunk" ||
                    arg == "--max_leaves") && i + 1 < argc) {
            args.maxLeavesPerChunk = std::max(1, std::stoi(argv[++i]));
        }
    }
    return args;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
int main(int argc, char** argv) {
    const auto started = std::chrono::steady_clock::now();

    PlannerArgs args;
    try {
        args = parseArgs(argc, argv);
    } catch (const std::exception& ex) {
        std::cerr << "Argument error: " << ex.what() << "\n";
        return 1;
    }

    const std::filesystem::path outputDir = args.outputDir;
    std::error_code ec;
    std::filesystem::create_directories(outputDir, ec);
    if (ec) {
        std::cerr << "Cannot create output directory: " << outputDir << " – " << ec.message() << "\n";
        return 1;
    }

    std::cout << "xcaf-step-planner v1.0.0\n";
    std::cout << "Input:    " << args.inputPath << "\n";
    std::cout << "Output:   " << outputDir.string() << "\n";
    std::cout << "Chunks:   target=" << args.targetChunks
              << "  max-leaves-per-chunk=" << args.maxLeavesPerChunk << "\n\n";

    // Verify input exists
    if (!std::filesystem::exists(args.inputPath)) {
        std::cerr << "Input file not found: " << args.inputPath << "\n";
        return 1;
    }

    PlannerResult result;
    result.inputPath = args.inputPath;
    result.targetChunks = args.targetChunks;

    try {
        result.fileSizeBytes = std::filesystem::file_size(args.inputPath);
    } catch (...) {
        result.fileSizeBytes = 0;
    }

    std::cout << "File size: " << std::fixed << std::setprecision(1)
              << (result.fileSizeBytes / (1024.0 * 1024.0)) << " MB\n";

    // -----------------------------------------------------------------------
    // 1. Read STEP → XCAF (no meshing)
    // -----------------------------------------------------------------------
    std::cout << "Reading STEP file...\n";
    Interface_Static::SetIVal("read.step.assembly.level", 1);

    Handle(TDocStd_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    STEPCAFControl_Reader reader;
    reader.SetNameMode(Standard_True);
    reader.SetColorMode(Standard_True);
    reader.SetLayerMode(Standard_True);
    reader.SetMatMode(Standard_True);

    const IFSelect_ReturnStatus status = reader.ReadFile(args.inputPath.c_str());
    if (status != IFSelect_RetDone) {
        std::cerr << "STEP read failed (status=" << static_cast<int>(status) << ")\n";
        return 1;
    }
    std::cout << "STEP file read OK.\n";

    std::cout << "Transferring to XCAF document...\n";
    if (!reader.Transfer(doc)) {
        std::cerr << "STEP→XCAF transfer failed.\n";
        return 1;
    }
    std::cout << "Transfer OK.\n";

    Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());

    TDF_LabelSequence freeShapes;
    shapeTool->GetFreeShapes(freeShapes);
    result.freeShapeCount = freeShapes.Length();
    std::cout << "Free shapes: " << result.freeShapeCount << "\n";

    // -----------------------------------------------------------------------
    // 2. Scan XCAF tree
    // -----------------------------------------------------------------------
    std::cout << "Scanning XCAF assembly tree...\n";

    std::map<std::string, PlannerNode> nodeMap;

    // Scan each free shape as a subtree
    std::vector<std::string> freeShapePaths;
    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
        const TDF_Label& freeLabel = freeShapes.Value(i);
        PlannerNode root = scanSubtree(shapeTool, freeLabel, "", 0, nodeMap);
        freeShapePaths.push_back(root.labelPath);
    }

    // Aggregate global stats
    result.totalLeafCount = 0;
    result.totalFaceCount = 0;
    result.totalSolidCount = 0;
    result.totalLeafInstances = 0;
    result.totalAssemblyCount = 0;
    std::set<void*> globalPrototypes;

    for (const auto& [path, node] : nodeMap) {
        if (node.isAssembly) ++result.totalAssemblyCount;
    }

    // Sum from free shapes only (children are already aggregated inside them)
    for (const std::string& fp : freeShapePaths) {
        const auto it = nodeMap.find(fp);
        if (it == nodeMap.end()) continue;
        const PlannerNode& node = it->second;
        result.totalLeafCount  += node.leafCount;
        result.totalFaceCount  += node.faceCount;
        result.totalSolidCount += node.solidCount;
        result.totalLeafInstances += node.totalLeafInstances;
        for (void* ptr : node.uniquePrototypes) {
            globalPrototypes.insert(ptr);
        }

        // Merge global bbox
        if (node.bboxValid) {
            if (!result.bboxValid) {
                result.bboxXmin = node.bboxXmin; result.bboxYmin = node.bboxYmin; result.bboxZmin = node.bboxZmin;
                result.bboxXmax = node.bboxXmax; result.bboxYmax = node.bboxYmax; result.bboxZmax = node.bboxZmax;
                result.bboxValid = true;
            } else {
                result.bboxXmin = std::min(result.bboxXmin, node.bboxXmin);
                result.bboxYmin = std::min(result.bboxYmin, node.bboxYmin);
                result.bboxZmin = std::min(result.bboxZmin, node.bboxZmin);
                result.bboxXmax = std::max(result.bboxXmax, node.bboxXmax);
                result.bboxYmax = std::max(result.bboxYmax, node.bboxYmax);
                result.bboxZmax = std::max(result.bboxZmax, node.bboxZmax);
            }
        }
    }

    result.totalUniquePrototypes = static_cast<int>(globalPrototypes.size());
    result.reuseRatio = (result.totalLeafInstances > 0)
        ? static_cast<double>(result.totalUniquePrototypes) / result.totalLeafInstances
        : 1.0;

    // Global complexity scores
    result.naiveComplexityScore =
        result.totalLeafCount * 1.0 + result.totalFaceCount * 0.3 + result.totalSolidCount * 2.0;

    const int extraInst = std::max(0, result.totalLeafInstances - result.totalUniquePrototypes);
    result.reuseAwareComplexityScore =
        result.totalUniquePrototypes * 1.0 + result.totalFaceCount * 0.3 +
        result.totalSolidCount * 2.0 + extraInst * 0.1;

    std::cout << "Scan complete. leaves=" << result.totalLeafCount
              << " faces=" << result.totalFaceCount
              << " solids=" << result.totalSolidCount
              << " uniquePrototypes=" << result.totalUniquePrototypes << "\n";

    // -----------------------------------------------------------------------
    // 3. Trigger evaluation
    // -----------------------------------------------------------------------
    if (result.fileSizeBytes > static_cast<std::uintmax_t>(kDefaultFileSizeThresholdBytes)) {
        std::ostringstream s;
        s << "file_size_threshold_exceeded (" << std::fixed << std::setprecision(1)
          << (result.fileSizeBytes / (1024.0 * 1024.0)) << " MB > 80 MB)";
        result.triggerReasons.push_back(s.str());
    }
    if (result.totalLeafCount > kDefaultLeafThreshold) {
        result.triggerReasons.push_back(
            "leaf_count_threshold_exceeded (" + std::to_string(result.totalLeafCount) + " > " +
            std::to_string(kDefaultLeafThreshold) + ")");
    }
    if (result.totalFaceCount > kDefaultFaceThreshold) {
        result.triggerReasons.push_back(
            "face_count_threshold_exceeded (" + std::to_string(result.totalFaceCount) + " > " +
            std::to_string(kDefaultFaceThreshold) + ")");
    }

    result.chunkingEnabled = !result.triggerReasons.empty();

    // -----------------------------------------------------------------------
    // 4. Chunk planning (only if triggered)
    // -----------------------------------------------------------------------
    if (result.chunkingEnabled) {
        // Determine chunk seeds: direct children of root(s), recursively split if needed
        std::vector<std::string> seeds;

        if (freeShapePaths.size() > 1) {
            // Multiple free shapes – use each free shape as a potential seed
            for (const std::string& fp : freeShapePaths) {
                flattenCandidates(shapeTool, fp, args.maxLeavesPerChunk, nodeMap, seeds, result.plannerWarnings);
            }
        } else if (!freeShapePaths.empty()) {
            // Single root – use its direct children as seeds
            const auto& rootIt = nodeMap.find(freeShapePaths[0]);
            if (rootIt != nodeMap.end() && rootIt->second.isAssembly &&
                !rootIt->second.childPaths.empty()) {
                for (const std::string& childPath : rootIt->second.childPaths) {
                    flattenCandidates(shapeTool, childPath, args.maxLeavesPerChunk, nodeMap, seeds, result.plannerWarnings);
                }
            } else {
                // Single giant non-assembly root
                seeds.push_back(freeShapePaths[0]);
                result.plannerWarnings.push_back(
                    "single_unstructured_root: cannot split further – model has no assembly hierarchy");
            }
        }

        std::cout << "Chunk seeds after recursive splitting: " << seeds.size() << "\n";

        // Bin-pack seeds into target chunks
        result.chunks = packChunks(args.targetChunks, seeds, nodeMap, result.plannerWarnings);

        // Fill parent label path from first free shape (common case)
        for (auto& chunk : result.chunks) {
            if (!freeShapePaths.empty()) {
                chunk.parentLabelPath = freeShapePaths[0];
            }
        }

        // Compute score totals for percentages
        double totalNaive = 0.0, totalReuse = 0.0;
        for (const auto& chunk : result.chunks) {
            totalNaive += chunk.naiveWorkScore;
            totalReuse += chunk.reuseAwareScore;
        }

        finaliseChunks(result.chunks, totalNaive, totalReuse);

        // Warn if reuse-aware score differs from naive by > 20% (significant mesh reuse in model)
        if (totalNaive > 0.0) {
            double reuseGain = (totalNaive - totalReuse) / totalNaive;
            if (reuseGain > 0.20) {
                std::ostringstream ss;
                ss << "significant_mesh_reuse_in_model: naive_score=" << std::setprecision(0) << totalNaive
                   << " reuse_aware_score=" << totalReuse
                   << " gain=" << std::setprecision(1) << (reuseGain * 100.0) << "%"
                   << " – chunk boundaries may reduce this benefit";
                result.plannerWarnings.push_back(ss.str());
            }
        }

        // Cross-chunk prototype sharing analysis
        analyzePrototypeSharingAcrossChunks(result.chunks, result.plannerWarnings);

        // Recommended parallelism
        result.recommendedParallelism = std::min(kMaxRecommendedParallelism,
                                                  std::max(1, args.targetChunks / 2));
        if (result.recommendedParallelism < 2) result.recommendedParallelism = 2;
    } else {
        result.targetChunks = 1;
        result.recommendedParallelism = 1;
    }

    // -----------------------------------------------------------------------
    // 5. Write JSON
    // -----------------------------------------------------------------------
    const auto planPath = outputDir / "large-model-plan.json";
    std::cout << "Writing plan to: " << planPath.string() << "\n";
    writePlan(planPath, result);
    std::cout << "Plan written.\n";

    // -----------------------------------------------------------------------
    // 6. Runtime and summary
    // -----------------------------------------------------------------------
    const auto finished = std::chrono::steady_clock::now();
    result.plannerRuntimeSeconds =
        std::chrono::duration<double>(finished - started).count();

    printSummary(result);

    std::cout << "Output: " << planPath.string() << "\n";
    return 0;
}
