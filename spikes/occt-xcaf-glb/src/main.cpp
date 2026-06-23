#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Poly_Triangle.hxx>
#include <Poly_Triangulation.hxx>
#include <Quantity_ColorRGBA.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <Standard_Version.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_LayerTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <deque>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <unordered_map>
#include <set>
#include <Bnd_Box.hxx>
#include <BRepBndLib.hxx>
#include <TopTools_MapOfShape.hxx>
#include <TopTools_DataMapOfShapeInteger.hxx>

#if defined(_WIN32)
#include <windows.h>
#include <psapi.h>
#pragma comment(lib, "psapi.lib")
#else
#include <unistd.h>
#endif

namespace {

struct Colour {
  double r = 0.62;
  double g = 0.64;
  double b = 0.66;
  double a = 1.0;
  std::string source = "default_neutral_grey";
  std::string materialSource = "default";
  std::string lookupPath;
  std::string colourType;
  std::string fallbackReason;
};

enum class ColourSpaceMode {
  Raw,
  SrgbToLinear
};

struct ColourSpaceConfig {
  ColourSpaceMode mode = ColourSpaceMode::Raw;
  std::string name = "raw";
};

enum class ColourMode {
  Experimental,
  XcafBaseline,
  StepPresentation
};

struct ColourModeConfig {
  ColourMode mode = ColourMode::Experimental;
  std::string name = "experimental";
  bool applyRawStepStyles = true;
  bool applyLayerColours = true;
};

struct LayerInfo {
  std::string name;
  TDF_Label label;
};

struct SubshapeColourCandidate {
  TopoDS_Shape shape;
  std::string labelPath;
  std::string displayName;
  std::string nameSource;
  std::vector<LayerInfo> layers;
  Colour colour;
  bool hasColour = false;
  Colour layerColour;
  bool hasLayerColour = false;
};

struct Quality {
  std::string name = "balanced";
  double linearDeflection = 0.35;
  double angularDeflection = 0.45;
  bool relative = true;
};

struct ReuseKey {
  void* tshapePtr = nullptr;
  double linearDeflection = 0.0;
  double angularDeflection = 0.0;
  bool relative = false;
  std::string materialSignature;
  bool isSafe = false;

  bool operator<(const ReuseKey& o) const {
    if (tshapePtr != o.tshapePtr) return tshapePtr < o.tshapePtr;
    if (linearDeflection != o.linearDeflection) return linearDeflection < o.linearDeflection;
    if (angularDeflection != o.angularDeflection) return angularDeflection < o.angularDeflection;
    if (relative != o.relative) return relative < o.relative;
    if (materialSignature != o.materialSignature) return materialSignature < o.materialSignature;
    return isSafe < o.isSafe;
  }
};

struct MeshPrimitive {
  std::string name;
  std::string labelPath;
  std::string instancePath;
  std::string displayName;
  std::string resolvedObjectName;
  std::string objectName;
  std::string partName;
  std::string blockName;
  std::string componentName;
  std::string productName;
  std::string representationName;
  std::string nameSource;
  std::vector<std::string> nameCandidates;
  std::string layer;
  std::string colourSource;
  std::string materialSource;
  std::string colourLookupPath;
  std::string colourType;
  std::string fallbackReason;
  std::string originalStepLabel;
  std::string originalStepName;
  std::string parentLabelPath;
  std::string shapeType;
  std::string transformSource;
  std::string localTransform;
  std::string accumulatedTransform;
  std::string colourTrace;
  std::string exactColourLookupPath;
  std::string labelRole;
  std::string parentChain;
  std::string instanceLabelLayers;
  std::string referredLabelLayers;
  std::string ancestorLayers;
  std::string matchedSubshapeLayers;
  std::string matchedSubshapeLabelPath;
  std::string matchedSubshapeName;
  std::string matchedSubshapeNameSource;
  std::string candidateColours;
  std::string instanceLabelColour;
  std::string referredLabelColour;
  std::string owningShapeColour;
  std::string ancestorColour;
  std::string layerColour;
  std::string rawStepMappingConfidence;
  std::string rawStepStyledItemId;
  std::string rawStepTargetId;
  std::string rawStepTargetType;
  std::string rawStepTargetScope;
  std::string rawStepTargetPath;
  std::string rawStepRejectedReason;
  std::string geometrySource;
  int subshapeColourCandidates = 0;
  bool ancestorHasColour = false;
  bool faceOrSubshapeHasColour = false;
  std::string stableObjectId;
  int faceCount = 0;
  Colour colour;
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<std::uint32_t> indices;
  bool isReused = false;
  void* tshapePtr = nullptr;
  gp_Trsf transform;
  ReuseKey reuseKey;
  std::array<float, 3> min = {
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max()};
  std::array<float, 3> max = {
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest()};
  std::array<float, 3> worldMin = {
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max()};
  std::array<float, 3> worldMax = {
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest()};
};

void computeWorldBounds(const std::array<float, 3>& localMin, const std::array<float, 3>& localMax, const gp_Trsf& transform, std::array<float, 3>& worldMin, std::array<float, 3>& worldMax);
void validateWorldBounds(const MeshPrimitive& primitive, const TopoDS_Shape& renderShape, const std::string& instancePath);

struct CachedGeometry {
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<std::uint32_t> indices;
  std::array<float, 3> min;
  std::array<float, 3> max;
  int faceCount = 0;
};

static std::map<ReuseKey, CachedGeometry> reuseCache;

struct Stats {
  int freeShapes = 0;
  int labelsProcessed = 0;
  int namedObjects = 0;
  int labelsWithColour = 0;
  int shapesTessellated = 0;
  int skippedShapes = 0;
  int failedShapes = 0;
  int primitivesExported = 0;
  std::uint64_t vertices = 0;
  std::uint64_t triangles = 0;
  std::uint64_t defaultMaterialUses = 0;
  int labelsWithLayerColourCandidates = 0;
  int subshapeLayerColourCandidates = 0;
  int rawStepEntities = 0;
  int rawStepStyledItems = 0;
  int rawStepColours = 0;
  int rawStepRepresentationColours = 0;
  int rawStepColourUses = 0;
  int rawStepAmbiguousRepresentationRejects = 0;
  int rawStepBroadRepresentationRejects = 0;
  double conversionSeconds = 0.0;
  std::map<std::string, int> coloursBySource;
  std::map<std::string, int> materialSourceCounts;
  std::map<std::string, int> rawStepMappingConfidenceCounts;
  std::set<std::string> uniqueColours;
  std::set<std::string> layers;
  int tessellationCacheHits = 0;
  int tessellationCacheMisses = 0;
  int reusedInstances = 0;
  int freshInstances = 0;
  double prototypeScanSeconds = 0.0;
  double prototypeCacheBuildSeconds = 0.0;
  int uniqueStoredTriangles = 0;
  int instancedTriangles = 0;
};

struct RawStepEntity {
  std::string id;
  std::string type;
  std::string args;
  std::vector<std::string> refs;
  std::string name;
};

struct RawStepStyleMatch {
  Colour colour;
  std::string representationId;
  std::string representationName;
  std::string styledItemId;
  std::string styledTargetId;
  std::string styledTargetType;
  std::string styledTargetScope;
  std::string styledTargetName;
  std::string colourId;
  std::string path;
  std::string confidence = "weak/name-only match";
  int representationCandidateCount = 0;
  int representationUniqueColourCount = 0;
  std::string rejectedReason;
};

struct RawStepColourAudit {
  std::string colourId;
  Colour colour;
  std::vector<std::string> styledItemIds;
  std::vector<std::string> mappedObjectNames;
};

struct StyledTopologyColour {
  TopoDS_Shape shape;
  RawStepStyleMatch match;
  std::string geometrySource;
};

struct FinalColourAudit {
  Colour colour;
  std::string hex;
  std::string materialName;
  std::set<std::string> sources;
  std::set<std::string> materialSources;
  std::uint64_t primitives = 0;
  std::uint64_t faces = 0;
  std::uint64_t triangles = 0;
};

struct DefaultGroup {
  std::string labelPath;
  std::string displayName;
  std::string layer;
  std::string parentLabelPath;
  std::string shapeType;
  bool ancestorHasColour = false;
  bool faceOrSubshapeHasColour = false;
  int primitives = 0;
  std::uint64_t triangles = 0;
  std::string fallbackReason;
};

struct ExportObjectKey {
  std::string labelPath;
  std::string displayName;
  std::string layer;
  std::string materialKey;
  std::string materialSource;
  std::string colourSource;
  std::string topologyKey;

  bool operator<(const ExportObjectKey& other) const {
    return std::tie(labelPath, displayName, layer, materialKey, materialSource, colourSource, topologyKey) <
           std::tie(other.labelPath, other.displayName, other.layer, other.materialKey, other.materialSource, other.colourSource, other.topologyKey);
  }
};

struct RepeatedComponentGroup {
  std::string key;
  std::string displayName;
  std::string originalStepLabel;
  std::string originalStepName;
  std::string layer;
  std::set<std::string> instancePaths;
  std::set<std::string> finalColours;
  std::set<std::string> materialSources;
  std::set<std::string> colourSources;
  int primitives = 0;
  int defaultPrimitives = 0;
  std::uint64_t triangles = 0;
  bool keywordMatch = false;
  std::vector<std::size_t> primitiveIndices;
};


size_t getMemoryUsageBytes() {
#if defined(_WIN32)
  PROCESS_MEMORY_COUNTERS pmc;
  if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
    return pmc.WorkingSetSize;
  }
#else
  long rss = 0;
  FILE* fp = fopen("/proc/self/statm", "r");
  if (fp) {
    if (fscanf(fp, "%*d%ld", &rss) == 1) {
      fclose(fp);
      return (size_t)rss * sysconf(_SC_PAGESIZE);
    }
    fclose(fp);
  }
#endif
  return 0;
}

class RawStepStyleResolver;
std::string jsonEscape(const std::string& value);
std::string shapeTypeName(const TopAbs_ShapeEnum type);
std::string labelEntry(const TDF_Label& label);
std::string readableLabelName(const TDF_Label& label);
bool findLabelColour(const Handle(XCAFDoc_ColorTool)& colourTool, const TDF_Label& label, Colour& colour);
void writeMaterialStyleProfile(const std::filesystem::path& path, const RawStepStyleResolver& styles, const Stats& stats);

std::ofstream logOut;
std::mutex logMutex;

void logLine(const std::string& message) {
  std::lock_guard<std::mutex> lock(logMutex);
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  if (logOut.is_open()) {
    logOut << std::put_time(std::localtime(&now), "%F %T") << " " << message << "\n";
    logOut.flush();
  }
  std::cout << message << std::endl;
}

class Watchdog {
 public:
  Watchdog() : stop_(false) {
    thread_ = std::thread(&Watchdog::run, this);
  }

  ~Watchdog() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) {
      thread_.join();
    }
  }

  void setStage(const std::string& stageName) {
    std::lock_guard<std::mutex> lock(mutex_);
    stageName_ = stageName;
    startTime_ = std::chrono::system_clock::now();
    warnedThresholds_.clear();
  }

 private:
  void run() {
    std::unique_lock<std::mutex> lock(mutex_);
    while (!stop_) {
      cv_.wait_for(lock, std::chrono::seconds(10), [this] { return stop_; });
      if (stop_) break;

      if (stageName_.empty()) continue;

      auto elapsed = std::chrono::system_clock::now() - startTime_;
      double elapsedMins = std::chrono::duration<double>(elapsed).count() / 60.0;

      for (int threshold : {5, 15, 30, 60}) {
        if (elapsedMins >= threshold && warnedThresholds_.find(threshold) == warnedThresholds_.end()) {
          std::string msg = "WARNING: Stage '" + stageName_ + 
                            "' has been active for over " + std::to_string(threshold) + 
                            " minutes (current elapsed: " + std::to_string(static_cast<int>(elapsedMins)) + " mins)";
          lock.unlock();
          logLine(msg);
          lock.lock();
          warnedThresholds_.insert(threshold);
        }
      }
    }
  }

  std::thread thread_;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::string stageName_;
  std::chrono::system_clock::time_point startTime_;
  std::set<int> warnedThresholds_;
  bool stop_;
};

class Profiler {
 public:
  struct Stage {
    std::string name;
    std::chrono::system_clock::time_point startTime;
    std::chrono::system_clock::time_point endTime;
    size_t startMem = 0;
    size_t endMem = 0;
    bool completed = false;
    std::map<std::string, std::string> counters;
  };

  Profiler(const std::filesystem::path& outputPath) : path_(outputPath) {}

  void startStage(const std::string& name) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& stage : stages_) {
      if (!stage.completed && stage.name == name) {
        return; // already active
      }
    }
    Stage s;
    s.name = name;
    s.startTime = std::chrono::system_clock::now();
    s.startMem = getMemoryUsageBytes();
    stages_.push_back(s);
    writeJson();
  }

  void endStage(const std::string& name, const std::map<std::string, std::string>& counters = {}) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& stage : stages_) {
      if (stage.name == name && !stage.completed) {
        stage.endTime = std::chrono::system_clock::now();
        stage.endMem = getMemoryUsageBytes();
        stage.completed = true;
        stage.counters = counters;
        break;
      }
    }
    writeJson();
  }

  void writeJson() {
    std::ofstream out(path_);
    if (!out) return;
    out << "[\n";
    for (size_t i = 0; i < stages_.size(); ++i) {
      const auto& stage = stages_[i];
      out << "  {\n";
      out << "    \"stage\": \"" << jsonEscape(stage.name) << "\",\n";
      out << "    \"start_time\": \"" << formatTime(stage.startTime) << "\",\n";
      if (stage.completed) {
        out << "    \"end_time\": \"" << formatTime(stage.endTime) << "\",\n";
        double ms = std::chrono::duration<double, std::milli>(stage.endTime - stage.startTime).count();
        out << "    \"elapsed_ms\": " << ms << ",\n";
        out << "    \"start_memory_bytes\": " << stage.startMem << ",\n";
        out << "    \"end_memory_bytes\": " << stage.endMem << ",\n";
      } else {
        out << "    \"end_time\": null,\n";
        out << "    \"elapsed_ms\": null,\n";
        out << "    \"start_memory_bytes\": " << stage.startMem << ",\n";
        out << "    \"end_memory_bytes\": null,\n";
      }
      out << "    \"completed\": " << (stage.completed ? "true" : "false") << ",\n";
      out << "    \"counters\": {\n";
      size_t countIndex = 0;
      for (const auto& [k, v] : stage.counters) {
        out << "      \"" << jsonEscape(k) << "\": \"" << jsonEscape(v) << "\"";
        if (++countIndex < stage.counters.size()) out << ",";
        out << "\n";
      }
      out << "    }\n";
      out << "  }";
      if (i + 1 < stages_.size()) out << ",";
      out << "\n";
    }
    out << "]\n";
  }

 private:
  std::filesystem::path path_;
  std::vector<Stage> stages_;
  std::mutex mutex_;

  static std::string formatTime(std::chrono::system_clock::time_point tp) {
    auto t = std::chrono::system_clock::to_time_t(tp);
    std::ostringstream ss;
    ss << std::put_time(std::localtime(&t), "%F %T");
    return ss.str();
  }
};

struct BodyInventoryItem {
  int id = 0;
  std::string type;
  bool hasLabel = false;
  std::string labelEntry;
  std::string name;
  int faceCount = 0;
  int edgeCount = 0;
  int vertexCount = 0;
  double xmin = 0, ymin = 0, zmin = 0;
  double xmax = 0, ymax = 0, zmax = 0;
  double diagonal = 0;
  bool hasColor = false;
  double colorR = 0, colorG = 0, colorB = 0, colorA = 1.0;
};

// Global cache statistics
std::atomic<uint64_t> styleCacheHits{0};
std::atomic<uint64_t> styleCacheMisses{0};
std::atomic<uint64_t> subshapeCacheHits{0};
std::atomic<uint64_t> subshapeCacheMisses{0};
std::atomic<uint64_t> styledFacesCount{0};
std::atomic<uint64_t> fallbackColorsCount{0};

struct TShapeColorKey {
  TopoDS_TShape* tshape;
  XCAFDoc_ColorType type;
  bool operator==(const TShapeColorKey& o) const {
    return tshape == o.tshape && type == o.type;
  }
};

struct TShapeColorKeyHash {
  std::size_t operator()(const TShapeColorKey& k) const {
    return std::hash<void*>()(k.tshape) ^ (std::hash<int>()(static_cast<int>(k.type)) << 1);
  }
};

std::unordered_map<TShapeColorKey, Colour, TShapeColorKeyHash> shapeColorCache;
bool globalDisableStyleCache = false;
std::atomic<uint64_t> shapeColorCacheHits{0};
std::atomic<uint64_t> shapeColorCacheMisses{0};

std::unordered_map<std::string, Colour> labelColorCache;
std::atomic<uint64_t> labelColorCacheHits{0};
std::atomic<uint64_t> labelColorCacheMisses{0};

int meshedCount = 0;
int totalShapesToMesh = 0;

void countLeafLabels(const Handle(XCAFDoc_ShapeTool)& shapeTool, const TDF_LabelSequence& freeShapes, int& count) {
  count = 0;
  struct Helper {
    static void count(const Handle(XCAFDoc_ShapeTool)& shapeTool, const TDF_Label& label, int& c) {
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
          count(shapeTool, children.Value(i), c);
        }
      } else {
        c++;
      }
    }
  };
  for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
    Helper::count(shapeTool, freeShapes.Value(i), count);
  }
}

void scanTopology(const TopoDS_Shape& shape,
                  int& compounds, int& compsolids, int& solids, int& shells, int& faces, int& edges, int& vertices,
                  int& uniqueCompounds, int& uniqueCompsolids, int& uniqueSolids, int& uniqueShells, int& uniqueFaces, int& uniqueEdges, int& uniqueVertices) {
  compounds = 0; compsolids = 0; solids = 0; shells = 0; faces = 0; edges = 0; vertices = 0;
  uniqueCompounds = 0; uniqueCompsolids = 0; uniqueSolids = 0; uniqueShells = 0; uniqueFaces = 0; uniqueEdges = 0; uniqueVertices = 0;

  TopTools_MapOfShape mapCompounds;
  TopTools_MapOfShape mapCompsolids;
  TopTools_MapOfShape mapSolids;
  TopTools_MapOfShape mapShells;
  TopTools_MapOfShape mapFaces;
  TopTools_MapOfShape mapEdges;
  TopTools_MapOfShape mapVertices;

  for (TopExp_Explorer exp(shape, TopAbs_COMPOUND); exp.More(); exp.Next()) {
    compounds++;
    mapCompounds.Add(exp.Current());
  }
  for (TopExp_Explorer exp(shape, TopAbs_COMPSOLID); exp.More(); exp.Next()) {
    compsolids++;
    mapCompsolids.Add(exp.Current());
  }
  for (TopExp_Explorer exp(shape, TopAbs_SOLID); exp.More(); exp.Next()) {
    solids++;
    mapSolids.Add(exp.Current());
  }
  for (TopExp_Explorer exp(shape, TopAbs_SHELL); exp.More(); exp.Next()) {
    shells++;
    mapShells.Add(exp.Current());
  }
  for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
    faces++;
    mapFaces.Add(exp.Current());
  }
  for (TopExp_Explorer exp(shape, TopAbs_EDGE); exp.More(); exp.Next()) {
    edges++;
    mapEdges.Add(exp.Current());
  }
  for (TopExp_Explorer exp(shape, TopAbs_VERTEX); exp.More(); exp.Next()) {
    vertices++;
    mapVertices.Add(exp.Current());
  }

  uniqueCompounds = mapCompounds.Extent();
  uniqueCompsolids = mapCompsolids.Extent();
  uniqueSolids = mapSolids.Extent();
  uniqueShells = mapShells.Extent();
  uniqueFaces = mapFaces.Extent();
  uniqueEdges = mapEdges.Extent();
  uniqueVertices = mapVertices.Extent();
}

void recursiveInventory(const TopoDS_Shape& shape,
                        const Handle(XCAFDoc_ShapeTool)& shapeTool,
                        const Handle(XCAFDoc_ColorTool)& colourTool,
                        std::vector<BodyInventoryItem>& items) {
  TopTools_MapOfShape mapSolids;
  for (TopExp_Explorer exp(shape, TopAbs_SOLID); exp.More(); exp.Next()) {
    mapSolids.Add(exp.Current());
  }

  std::vector<TopoDS_Shape> candidates;
  if (mapSolids.Extent() > 0) {
    for (TopExp_Explorer exp(shape, TopAbs_SOLID); exp.More(); exp.Next()) {
      if (mapSolids.Remove(exp.Current())) {
        candidates.push_back(exp.Current());
      }
    }
  } else {
    TopTools_MapOfShape mapShells;
    for (TopExp_Explorer exp(shape, TopAbs_SHELL); exp.More(); exp.Next()) {
      mapShells.Add(exp.Current());
    }
    if (mapShells.Extent() > 0) {
      for (TopExp_Explorer exp(shape, TopAbs_SHELL); exp.More(); exp.Next()) {
        if (mapShells.Remove(exp.Current())) {
          candidates.push_back(exp.Current());
        }
      }
    } else {
      TopTools_MapOfShape mapFaces;
      for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
        mapFaces.Add(exp.Current());
      }
      for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
        if (mapFaces.Remove(exp.Current())) {
          candidates.push_back(exp.Current());
        }
      }
    }
  }

  for (size_t i = 0; i < candidates.size(); ++i) {
    const auto& candidate = candidates[i];
    BodyInventoryItem item;
    item.id = static_cast<int>(items.size());
    item.type = shapeTypeName(candidate.ShapeType());

    TopTools_MapOfShape candidateFaces;
    TopTools_MapOfShape candidateEdges;
    TopTools_MapOfShape candidateVertices;
    for (TopExp_Explorer exp(candidate, TopAbs_FACE); exp.More(); exp.Next()) candidateFaces.Add(exp.Current());
    for (TopExp_Explorer exp(candidate, TopAbs_EDGE); exp.More(); exp.Next()) candidateEdges.Add(exp.Current());
    for (TopExp_Explorer exp(candidate, TopAbs_VERTEX); exp.More(); exp.Next()) candidateVertices.Add(exp.Current());

    item.faceCount = candidateFaces.Extent();
    item.edgeCount = candidateEdges.Extent();
    item.vertexCount = candidateVertices.Extent();

    Bnd_Box box;
    BRepBndLib::Add(candidate, box);
    if (!box.IsVoid()) {
      Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
      box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
      item.xmin = xmin; item.ymin = ymin; item.zmin = zmin;
      item.xmax = xmax; item.ymax = ymax; item.zmax = zmax;
      double dx = xmax - xmin;
      double dy = ymax - ymin;
      double dz = zmax - zmin;
      item.diagonal = std::sqrt(dx*dx + dy*dy + dz*dz);
    }

    TDF_Label label;
    if (shapeTool->FindShape(candidate, label)) {
      item.hasLabel = true;
      item.labelEntry = labelEntry(label);
      item.name = readableLabelName(label);
      Colour col;
      if (findLabelColour(colourTool, label, col)) {
        item.hasColor = true;
        item.colorR = col.r;
        item.colorG = col.g;
        item.colorB = col.b;
        item.colorA = col.a;
      }
    }

    items.push_back(item);
  }
}

void writeBodyInventory(const std::filesystem::path& path,
                        int compounds, int compsolids, int solids, int shells, int faces, int edges, int vertices,
                        int uniqueCompounds, int uniqueCompsolids, int uniqueSolids, int uniqueShells, int uniqueFaces, int uniqueEdges, int uniqueVertices,
                        const std::vector<BodyInventoryItem>& items) {
  std::ofstream out(path);
  if (!out) return;
  out << "{\n";
  out << "  \"traversedCounts\": {\n";
  out << "    \"compounds\": " << compounds << ",\n";
  out << "    \"compsolids\": " << compsolids << ",\n";
  out << "    \"solids\": " << solids << ",\n";
  out << "    \"shells\": " << shells << ",\n";
  out << "    \"faces\": " << faces << ",\n";
  out << "    \"edges\": " << edges << ",\n";
  out << "    \"vertices\": " << vertices << "\n";
  out << "  },\n";
  out << "  \"uniqueCounts\": {\n";
  out << "    \"compounds\": " << uniqueCompounds << ",\n";
  out << "    \"compsolids\": " << uniqueCompsolids << ",\n";
  out << "    \"solids\": " << uniqueSolids << ",\n";
  out << "    \"shells\": " << uniqueShells << ",\n";
  out << "    \"faces\": " << uniqueFaces << ",\n";
  out << "    \"edges\": " << uniqueEdges << ",\n";
  out << "    \"vertices\": " << uniqueVertices << "\n";
  out << "  },\n";
  out << "  \"candidatesCount\": " << items.size() << ",\n";
  out << "  \"candidates\": [\n";
  for (size_t i = 0; i < items.size(); ++i) {
    const auto& item = items[i];
    out << "    {\n";
    out << "      \"id\": " << item.id << ",\n";
    out << "      \"type\": \"" << jsonEscape(item.type) << "\",\n";
    out << "      \"has_xcaf_label\": " << (item.hasLabel ? "true" : "false") << ",\n";
    out << "      \"label_entry\": \"" << jsonEscape(item.labelEntry) << "\",\n";
    out << "      \"name\": \"" << jsonEscape(item.name) << "\",\n";
    out << "      \"faces\": " << item.faceCount << ",\n";
    out << "      \"edges\": " << item.edgeCount << ",\n";
    out << "      \"vertices\": " << item.vertexCount << ",\n";
    out << "      \"bbox\": [" << item.xmin << ", " << item.ymin << ", " << item.zmin << ", " 
                           << item.xmax << ", " << item.ymax << ", " << item.zmax << "],\n";
    out << "      \"bbox_diagonal\": " << item.diagonal << ",\n";
    out << "      \"has_color\": " << (item.hasColor ? "true" : "false") << ",\n";
    out << "      \"color\": [" << item.colorR << ", " << item.colorG << ", " << item.colorB << ", " << item.colorA << "]\n";
    out << "    }";
    if (i + 1 < items.size()) out << ",";
    out << "\n";
  }
  out << "  ]\n";
  out << "}\n";
}



std::string jsonEscape(const std::string& value) {
  std::ostringstream out;
  for (const unsigned char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
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

void writeString(std::ostream& out, const std::string& value) {
  out << '"' << jsonEscape(value) << '"';
}

void writeStringVector(std::ostream& out, const std::vector<std::string>& values, std::size_t limit);

std::string labelEntry(const TDF_Label& label) {
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return entry.ToCString();
}

std::string appendInstancePath(const std::string& parent, const std::string& labelPath) {
  return parent.empty() ? labelPath : parent + ">" + labelPath;
}

std::string extendedToUtf8(const TCollection_ExtendedString& value) {
  TCollection_AsciiString ascii(value, '?');
  return ascii.ToCString();
}

std::string labelName(const TDF_Label& label) {
  Handle(TDataStd_Name) nameAttr;
  if (label.FindAttribute(TDataStd_Name::GetID(), nameAttr)) {
    return extendedToUtf8(nameAttr->Get());
  }
  return {};
}

std::string safeName(const std::string& value, const std::string& fallback) {
  return value.empty() ? fallback : value;
}

std::string normalizeDisplayWhitespace(const std::string& value);

bool isRawLabelName(const std::string& value) {
  if (value.empty()) return true;
  if (value.rfind("=>[", 0) == 0 && value.back() == ']') return true;
  std::string upper = value;
  std::transform(upper.begin(), upper.end(), upper.begin(), [](const unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  if (upper == "DOCUMENT" || upper == "COMPOUND" || upper == "COMPSOLID" ||
      upper == "SOLID" || upper == "SHELL" || upper == "FACE" || upper == "SHAPE" ||
      upper == "OPEN CASCADE STEP TRANSLATOR") return true;
  if (upper.rfind("BREP_REP_", 0) == 0 || upper.rfind("SHELL_REP_", 0) == 0) return true;
  if (upper.rfind("BREP_", 0) == 0 && upper.size() > 5 &&
      std::all_of(upper.begin() + 5, upper.end(), [](const unsigned char c) { return std::isdigit(c); })) return true;
  return std::all_of(value.begin(), value.end(), [](const unsigned char c) {
    return std::isdigit(c) || c == ':';
  });
}

std::string readableLabelName(const TDF_Label& label) {
  const std::string value = label.IsNull() ? "" : labelName(label);
  return isRawLabelName(value) ? "" : normalizeDisplayWhitespace(value);
}

std::string shapeTypeName(const TopAbs_ShapeEnum type) {
  switch (type) {
    case TopAbs_COMPOUND: return "COMPOUND";
    case TopAbs_COMPSOLID: return "COMPSOLID";
    case TopAbs_SOLID: return "SOLID";
    case TopAbs_SHELL: return "SHELL";
    case TopAbs_FACE: return "FACE";
    case TopAbs_WIRE: return "WIRE";
    case TopAbs_EDGE: return "EDGE";
    case TopAbs_VERTEX: return "VERTEX";
    case TopAbs_SHAPE: return "SHAPE";
  }
  return "UNKNOWN";
}

std::string colourKey(const Colour& colour) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6)
      << colour.r << "," << colour.g << "," << colour.b << "," << colour.a;
  return out.str();
}

double clamp01(const double value) {
  return std::max(0.0, std::min(1.0, value));
}

double srgbComponentToLinear(const double value) {
  const double c = clamp01(value);
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return std::pow((c + 0.055) / 1.055, 2.4);
}

Colour convertColourForGlb(const Colour& colour, const ColourSpaceConfig& colourSpace) {
  Colour converted = colour;
  if (colourSpace.mode == ColourSpaceMode::SrgbToLinear) {
    converted.r = srgbComponentToLinear(colour.r);
    converted.g = srgbComponentToLinear(colour.g);
    converted.b = srgbComponentToLinear(colour.b);
  }
  return converted;
}

Colour linearizedStepPresentationColour(const Colour& colour) {
  Colour converted = colour;
  converted.r = srgbComponentToLinear(colour.r);
  converted.g = srgbComponentToLinear(colour.g);
  converted.b = srgbComponentToLinear(colour.b);
  return converted;
}

int colourChannelToByte(const double value) {
  return static_cast<int>(std::round(clamp01(value) * 255.0));
}

std::string colourHex(const Colour& colour) {
  std::ostringstream out;
  out << "#"
      << std::uppercase << std::hex << std::setfill('0')
      << std::setw(2) << colourChannelToByte(colour.r)
      << std::setw(2) << colourChannelToByte(colour.g)
      << std::setw(2) << colourChannelToByte(colour.b);
  return out.str();
}

std::string colourSummary(const bool hasColour, const Colour& colour) {
  if (!hasColour) {
    return "none";
  }
  return colourKey(colour) + " source=" + colour.source + " lookup=" + colour.lookupPath;
}

std::string layerNames(const std::vector<LayerInfo>& layers) {
  std::set<std::string> names;
  for (const auto& layer : layers) {
    if (!layer.name.empty()) {
      names.insert(layer.name);
    }
  }
  std::ostringstream out;
  bool first = true;
  for (const auto& name : names) {
    if (!first) out << " | ";
    first = false;
    out << name;
  }
  return out.str();
}

std::vector<LayerInfo> mergeLayers(
    const std::vector<LayerInfo>& firstLayers,
    const std::vector<LayerInfo>& secondLayers) {
  std::vector<LayerInfo> merged = firstLayers;
  merged.insert(merged.end(), secondLayers.begin(), secondLayers.end());
  std::sort(merged.begin(), merged.end(), [](const LayerInfo& a, const LayerInfo& b) {
    return a.name < b.name;
  });
  merged.erase(std::unique(merged.begin(), merged.end(), [](const LayerInfo& a, const LayerInfo& b) {
    return a.name == b.name;
  }), merged.end());
  return merged;
}

std::string appendChain(const std::string& parent, const std::string& item) {
  return parent.empty() ? item : parent + ">" + item;
}

std::string appendCandidateSummary(const std::string& existing, const std::string& name, const bool hasColour, const Colour& colour) {
  std::string next = name + "=" + colourSummary(hasColour, colour);
  return existing.empty() ? next : existing + "; " + next;
}

std::string colourTraceSummary(
    const bool faceOrSubshapeHasColour,
    const Colour& finalColour,
    const bool labelHasColour,
    const Colour& labelColour,
    const bool owningShapeHasColour,
    const Colour& owningShapeColour,
    const bool referredHasColour,
    const Colour& referredColour,
    const bool ancestorHasColour,
    const Colour& ancestorColour,
    const bool layerHasColour,
    const Colour& layerColour,
    const bool rawStepHasColour,
    const Colour& rawStepColour,
    const int subshapeCandidateCount) {
  std::ostringstream out;
  out << "final=" << colourKey(finalColour)
      << " source=" << finalColour.source
      << " lookup=" << finalColour.lookupPath
      << "; faceOrSubshape=" << (faceOrSubshapeHasColour ? "hit" : "none")
      << "; instanceLabel=" << colourSummary(labelHasColour, labelColour)
      << "; owningShape=" << colourSummary(owningShapeHasColour, owningShapeColour)
      << "; referredLabel=" << colourSummary(referredHasColour, referredColour)
      << "; rawStepStyledItem=" << colourSummary(rawStepHasColour, rawStepColour)
      << "; ancestor=" << colourSummary(ancestorHasColour, ancestorColour)
      << "; layer=" << colourSummary(layerHasColour, layerColour)
      << "; subshapeCandidates=" << subshapeCandidateCount;
  return out.str();
}

std::string lowerAscii(const std::string& value) {
  std::string result = value;
  std::transform(result.begin(), result.end(), result.begin(), [](const unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return result;
}

std::string normalizeStepName(const std::string& value) {
  std::string result;
  bool lastWasSpace = true;
  for (const unsigned char c : value) {
    if (std::isalnum(c)) {
      result.push_back(static_cast<char>(std::tolower(c)));
      lastWasSpace = false;
    } else if (!lastWasSpace) {
      result.push_back(' ');
      lastWasSpace = true;
    }
  }
  if (!result.empty() && result.back() == ' ') {
    result.pop_back();
  }
  return result;
}

std::string normalizeDisplayWhitespace(const std::string& value) {
  std::string result;
  bool pendingSpace = false;
  for (const unsigned char c : value) {
    if (c == '\r' || c == '\n') {
      continue;
    }
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

std::string unquoteStepString(const std::string& value) {
  std::string trimmed = value;
  while (!trimmed.empty() && std::isspace(static_cast<unsigned char>(trimmed.front()))) {
    trimmed.erase(trimmed.begin());
  }
  while (!trimmed.empty() && std::isspace(static_cast<unsigned char>(trimmed.back()))) {
    trimmed.pop_back();
  }
  if (trimmed.size() >= 2 && trimmed.front() == '\'' && trimmed.back() == '\'') {
    std::string out;
    for (std::size_t i = 1; i + 1 < trimmed.size(); ++i) {
      if (trimmed[i] == '\'' && i + 1 < trimmed.size() - 1 && trimmed[i + 1] == '\'') {
        out.push_back('\'');
        i += 1;
      } else {
        out.push_back(trimmed[i]);
      }
    }
    return out;
  }
  return trimmed;
}

std::string firstStepString(const std::string& args) {
  bool inString = false;
  std::size_t start = 0;
  for (std::size_t i = 0; i < args.size(); ++i) {
    if (args[i] != '\'') {
      continue;
    }
    if (inString && i + 1 < args.size() && args[i + 1] == '\'') {
      i += 1;
      continue;
    }
    if (inString) {
      return unquoteStepString(args.substr(start, i - start + 1));
    }
    inString = true;
    start = i;
  }
  return {};
}

std::vector<std::string> splitTopLevel(const std::string& args) {
  std::vector<std::string> parts;
  int depth = 0;
  bool inString = false;
  std::size_t start = 0;
  for (std::size_t i = 0; i < args.size(); ++i) {
    const char c = args[i];
    if (c == '\'') {
      if (inString && i + 1 < args.size() && args[i + 1] == '\'') {
        i += 1;
        continue;
      }
      inString = !inString;
    } else if (!inString) {
      if (c == '(') {
        depth += 1;
      } else if (c == ')') {
        depth = std::max(0, depth - 1);
      } else if (c == ',' && depth == 0) {
        parts.push_back(args.substr(start, i - start));
        start = i + 1;
      }
    }
  }
  if (start < args.size()) {
    parts.push_back(args.substr(start));
  }
  return parts;
}

std::vector<std::string> extractStepRefs(const std::string& args) {
  std::set<std::string> refs;
  for (std::size_t i = 0; i < args.size(); ++i) {
    if (args[i] != '#') {
      continue;
    }
    std::size_t j = i + 1;
    while (j < args.size() && std::isdigit(static_cast<unsigned char>(args[j]))) {
      j += 1;
    }
    if (j > i + 1) {
      refs.insert(args.substr(i, j - i));
      i = j - 1;
    }
  }
  return {refs.begin(), refs.end()};
}

std::vector<double> extractNumbers(const std::string& value) {
  std::vector<double> numbers;
  for (std::size_t i = 0; i < value.size();) {
    if (!(std::isdigit(static_cast<unsigned char>(value[i])) || value[i] == '-' || value[i] == '+' || value[i] == '.')) {
      i += 1;
      continue;
    }
    std::size_t consumed = 0;
    try {
      const double number = std::stod(value.substr(i), &consumed);
      if (consumed > 0) {
        numbers.push_back(number);
        i += consumed;
        continue;
      }
    } catch (...) {
    }
    i += 1;
  }
  return numbers;
}

std::map<std::string, RawStepEntity> parseRawStepEntities(const std::string& inputPath) {
  std::ifstream in(inputPath);
  if (!in) {
    throw std::runtime_error("Could not open STEP input for raw style pass: " + inputPath);
  }
  std::ostringstream buffer;
  buffer << in.rdbuf();
  const std::string text = buffer.str();
  std::map<std::string, RawStepEntity> entities;

  std::size_t i = 0;
  while (true) {
    const std::size_t hashAt = text.find('#', i);
    if (hashAt == std::string::npos) {
      break;
    }
    std::size_t idEnd = hashAt + 1;
    while (idEnd < text.size() && std::isdigit(static_cast<unsigned char>(text[idEnd]))) {
      idEnd += 1;
    }
    if (idEnd == hashAt + 1) {
      i = hashAt + 1;
      continue;
    }
    std::size_t j = idEnd;
    while (j < text.size() && std::isspace(static_cast<unsigned char>(text[j]))) {
      j += 1;
    }
    if (j >= text.size() || text[j] != '=') {
      i = idEnd;
      continue;
    }
    j += 1;
    while (j < text.size() && std::isspace(static_cast<unsigned char>(text[j]))) {
      j += 1;
    }
    const std::size_t typeStart = j;
    while (j < text.size() && (std::isalnum(static_cast<unsigned char>(text[j])) || text[j] == '_')) {
      j += 1;
    }
    std::string type = text.substr(typeStart, j - typeStart);
    std::transform(type.begin(), type.end(), type.begin(), [](const unsigned char c) { return static_cast<char>(std::toupper(c)); });
    while (j < text.size() && std::isspace(static_cast<unsigned char>(text[j]))) {
      j += 1;
    }
    if (j >= text.size() || text[j] != '(') {
      i = j + 1;
      continue;
    }

    const std::size_t argsStart = j + 1;
    int depth = 1;
    bool inString = false;
    j += 1;
    for (; j < text.size(); ++j) {
      const char c = text[j];
      if (c == '\'') {
        if (inString && j + 1 < text.size() && text[j + 1] == '\'') {
          j += 1;
          continue;
        }
        inString = !inString;
      } else if (!inString) {
        if (c == '(') {
          depth += 1;
        } else if (c == ')') {
          depth -= 1;
          if (depth == 0) {
            const std::string id = text.substr(hashAt, idEnd - hashAt);
            const std::string args = text.substr(argsStart, j - argsStart);
            entities[id] = {id, type, args, extractStepRefs(args), firstStepString(args)};
            break;
          }
        }
      }
    }
    i = j + 1;
  }

  return entities;
}

bool isRepresentationEntity(const std::string& type) {
  return type.find("REPRESENTATION") != std::string::npos;
}

bool isBrepOrTopologyEntity(const std::string& type) {
  return type.find("BREP") != std::string::npos ||
         type.find("SOLID") != std::string::npos ||
         type.find("SHELL") != std::string::npos ||
         type.find("FACE") != std::string::npos ||
         type.find("CURVE") != std::string::npos ||
         type.find("EDGE") != std::string::npos ||
         type.find("LOOP") != std::string::npos ||
         type.find("VERTEX") != std::string::npos;
}

bool isRawStyleTraversalEntity(const std::string& type) {
  return type == "STYLED_ITEM" ||
         type == "PRESENTATION_STYLE_ASSIGNMENT" ||
         type.find("STYLE") != std::string::npos ||
         type.find("COLOUR") != std::string::npos ||
         type.find("COLOR") != std::string::npos;
}

std::string rawStyleConfidenceForTarget(const std::string& type) {
  if (type == "MANIFOLD_SOLID_BREP") {
    return "exact manifold solid BREP";
  }
  if (type.find("BREP") != std::string::npos) {
    return "exact BREP id";
  }
  if (isBrepOrTopologyEntity(type)) {
    return "exact topology id";
  }
  if (isRepresentationEntity(type)) {
    return "shape representation path";
  }
  return "weak/name-only match";
}

bool isStrongRawStyleConfidence(const std::string& confidence) {
  return confidence == "exact BREP id" ||
         confidence == "exact manifold solid BREP" ||
         confidence == "exact topology id";
}

int stepEntityNumericId(const std::string& id) {
  if (id.size() < 2 || id.front() != '#') {
    return 0;
  }
  try {
    return std::stoi(id.substr(1));
  } catch (...) {
    return 0;
  }
}

std::string rawStyleTargetScope(const std::string& type) {
  if (type == "ADVANCED_BREP_SHAPE_REPRESENTATION") {
    return "advanced BREP shape representation";
  }
  if (isRepresentationEntity(type)) {
    return "representation";
  }
  if (type == "MANIFOLD_SOLID_BREP") {
    return "manifold solid BREP";
  }
  if (type.find("FACE") != std::string::npos) {
    return "face";
  }
  if (type.find("EDGE") != std::string::npos || type.find("CURVE") != std::string::npos) {
    return "edge/curve";
  }
  if (isBrepOrTopologyEntity(type)) {
    return "other topology";
  }
  return "other";
}

bool colourFromStepEntity(const RawStepEntity& entity, Colour& colour) {
  if (entity.type != "COLOUR_RGB") {
    return false;
  }
  const std::vector<double> numbers = extractNumbers(entity.args);
  if (numbers.size() < 3) {
    return false;
  }
  colour.r = numbers[numbers.size() - 3];
  colour.g = numbers[numbers.size() - 2];
  colour.b = numbers[numbers.size() - 1];
  colour.a = 1.0;
  colour.source = "raw_step_styled_item";
  colour.materialSource = "raw_step_styled_item";
  colour.colourType = "surface";
  colour.fallbackReason.clear();
  return true;
}

std::map<std::string, std::vector<std::string>> buildReverseStepRefs(const std::map<std::string, RawStepEntity>& entities) {
  std::map<std::string, std::vector<std::string>> reverse;
  for (const auto& [id, entity] : entities) {
    for (const auto& ref : entity.refs) {
      reverse[ref].push_back(id);
    }
  }
  return reverse;
}

std::vector<std::string> findColoursFromStyledItem(
    const std::map<std::string, RawStepEntity>& entities,
    const std::string& styledItemId) {
  std::vector<std::string> colourIds;
  std::set<std::string> seen;
  std::deque<std::pair<std::string, int>> queue;
  queue.push_back({styledItemId, 0});
  seen.insert(styledItemId);
  while (!queue.empty()) {
    const auto [current, depth] = queue.front();
    queue.pop_front();
    if (depth > 8) {
      continue;
    }
    const auto found = entities.find(current);
    if (found == entities.end()) {
      continue;
    }
    for (const auto& ref : found->second.refs) {
      if (!seen.insert(ref).second) {
        continue;
      }
      const auto refEntity = entities.find(ref);
      if (refEntity == entities.end()) {
        continue;
      }
      if (refEntity->second.type == "COLOUR_RGB") {
        colourIds.push_back(ref);
      } else if (isRawStyleTraversalEntity(refEntity->second.type)) {
        queue.push_back({ref, depth + 1});
      }
    }
  }
  return colourIds;
}

std::string pathToString(const std::vector<std::string>& path, const std::map<std::string, RawStepEntity>& entities) {
  std::ostringstream out;
  for (std::size_t i = 0; i < path.size(); ++i) {
    if (i > 0) out << " -> ";
    out << path[i];
    const auto found = entities.find(path[i]);
    if (found != entities.end()) {
      out << " " << found->second.type;
    }
  }
  return out.str();
}

class RawStepStyleResolver {
 public:
  void load(const std::string& inputPath, Profiler* profiler = nullptr) {
    if (profiler) profiler->startStage("Raw STEP style parse");
    entities_ = parseRawStepEntities(inputPath);
    if (profiler) profiler->endStage("Raw STEP style parse", {{"entities", std::to_string(entities_.size())}});

    if (profiler) profiler->startStage("Raw STEP style index build");
    reverseRefs_ = buildReverseStepRefs(entities_);
    buildStyledItemIndex();
    buildRepresentationIndex();
    buildProductNameIndex();
    buildLayerTargetNameIndex();
    if (profiler) {
      profiler->endStage("Raw STEP style index build", {
        {"styledItems", std::to_string(styledItemCount_)},
        {"colours", std::to_string(colourCount_)},
        {"representationColours", std::to_string(representationColourCount_)}
      });
    }
  }

  int entityCount() const { return static_cast<int>(entities_.size()); }
  int styledItemCount() const { return styledItemCount_; }
  int colourCount() const { return colourCount_; }
  int representationColourCount() const { return representationColourCount_; }
  const std::string& uniqueProductName() const { return uniqueProductName_; }
  const std::vector<std::string>& productNameCandidates() const { return productNameCandidates_; }

  void applyExactLayerTargetNames(std::vector<SubshapeColourCandidate>& candidates) const {
    std::map<std::string, std::vector<std::size_t>> candidatesByLayer;
    for (std::size_t i = 0; i < candidates.size(); ++i) {
      if (candidates[i].layers.empty()) continue;
      candidatesByLayer[normalizeStepName(candidates[i].layers.front().name)].push_back(i);
    }
    for (auto& [layer, candidateIndices] : candidatesByLayer) {
      const auto targetsFound = namedBrepTargetsByLayer_.find(layer);
      if (targetsFound == namedBrepTargetsByLayer_.end() ||
          targetsFound->second.size() != candidateIndices.size()) {
        continue;
      }
      std::sort(candidateIndices.begin(), candidateIndices.end(), [&](const std::size_t a, const std::size_t b) {
        return labelEntryOrdinal(candidates[a].labelPath) < labelEntryOrdinal(candidates[b].labelPath);
      });
      for (std::size_t i = 0; i < candidateIndices.size(); ++i) {
        candidates[candidateIndices[i]].displayName = targetsFound->second[i].second;
        candidates[candidateIndices[i]].nameSource = "step-layer-target-brep";
      }
    }
  }

  bool findForNames(
      const std::vector<std::string>& names,
      RawStepStyleMatch& match,
      RawStepStyleMatch& rejectedMatch) const {
    std::set<std::string> checkedKeys;
    for (const auto& name : names) {
      const std::string normalized = normalizeStepName(name);
      if (normalized.empty() || !checkedKeys.insert(normalized).second) {
        continue;
      }
      const auto found = matchesByNormalizedRepresentationName_.find(normalized);
      if (found == matchesByNormalizedRepresentationName_.end() || found->second.empty()) {
        continue;
      }
      std::vector<RawStepStyleMatch> strongCandidates;
      for (const auto& candidate : found->second) {
        if (!isStrongRawStyleConfidence(candidate.confidence)) {
          if (rejectedMatch.rejectedReason.empty()) {
            rejectedMatch = candidate;
            rejectedMatch.rejectedReason = "broad representation-level or weak raw STEP style target";
          }
          continue;
        }
        strongCandidates.push_back(candidate);
      }
      std::set<std::string> uniqueColours;
      for (const auto& candidate : strongCandidates) {
        uniqueColours.insert(colourKey(candidate.colour));
      }
      if (strongCandidates.size() == 1) {
        match = strongCandidates.front();
        match.representationCandidateCount = 1;
        match.representationUniqueColourCount = 1;
        return true;
      }
      if (!strongCandidates.empty()) {
        rejectedMatch = strongCandidates.front();
        rejectedMatch.representationCandidateCount = static_cast<int>(strongCandidates.size());
        rejectedMatch.representationUniqueColourCount = static_cast<int>(uniqueColours.size());
        rejectedMatch.rejectedReason = "ambiguous named representation has " +
            std::to_string(strongCandidates.size()) +
            " strong styled targets and " +
            std::to_string(uniqueColours.size()) +
            " unique raw colours; not safe to apply one colour to the whole component";
      }
    }
    return false;
  }

  std::vector<RawStepStyleMatch> strongTopologyMatchesForNames(
      const std::vector<std::string>& names,
      RawStepStyleMatch& rejectedMatch) const {
    std::set<std::string> checkedKeys;
    for (const auto& name : names) {
      const std::string normalized = normalizeStepName(name);
      if (normalized.empty() || !checkedKeys.insert(normalized).second) {
        continue;
      }
      const auto found = matchesByNormalizedRepresentationName_.find(normalized);
      if (found == matchesByNormalizedRepresentationName_.end() || found->second.empty()) {
        continue;
      }
      std::vector<RawStepStyleMatch> strongCandidates;
      for (const auto& candidate : found->second) {
        if (isStrongRawStyleConfidence(candidate.confidence)) {
          strongCandidates.push_back(candidate);
        } else if (rejectedMatch.rejectedReason.empty()) {
          rejectedMatch = candidate;
          rejectedMatch.rejectedReason = "broad representation-level or weak raw STEP style target";
        }
      }
      if (!strongCandidates.empty()) {
        std::sort(strongCandidates.begin(), strongCandidates.end(), [](const RawStepStyleMatch& a, const RawStepStyleMatch& b) {
          return stepEntityNumericId(a.styledTargetId) < stepEntityNumericId(b.styledTargetId);
        });
        return strongCandidates;
      }
    }
    return {};
  }

  std::vector<RawStepStyleMatch> uniqueStrongTopologyRepresentationGroup(
      RawStepStyleMatch& rejectedMatch) const {
    std::vector<RawStepStyleMatch> uniqueGroup;
    int strongGroupCount = 0;
    for (const auto& [name, matches] : matchesByNormalizedRepresentationName_) {
      std::vector<RawStepStyleMatch> strongCandidates;
      for (const auto& candidate : matches) {
        if (isStrongRawStyleConfidence(candidate.confidence)) {
          strongCandidates.push_back(candidate);
        }
      }
      if (strongCandidates.empty()) {
        continue;
      }
      strongGroupCount += 1;
      if (strongGroupCount == 1) {
        uniqueGroup = strongCandidates;
      } else {
        break;
      }
    }
    if (strongGroupCount != 1) {
      if (strongGroupCount > 1 && !matchesByNormalizedRepresentationName_.empty()) {
        rejectedMatch.rejectedReason = "multiple STEP representation groups have strong styled topology targets; no unique representation group was selected";
      }
      return {};
    }
    std::sort(uniqueGroup.begin(), uniqueGroup.end(), [](const RawStepStyleMatch& a, const RawStepStyleMatch& b) {
      return stepEntityNumericId(a.styledTargetId) < stepEntityNumericId(b.styledTargetId);
    });
    return uniqueGroup;
  }

  const std::map<std::string, RawStepColourAudit>& colourAudit() const { return colourAudit_; }

 private:
  static int labelEntryOrdinal(const std::string& labelPath) {
    const std::size_t separator = labelPath.rfind(':');
    if (separator == std::string::npos) return 0;
    try {
      return std::stoi(labelPath.substr(separator + 1));
    } catch (...) {
      return 0;
    }
  }

  void buildLayerTargetNameIndex() {
    for (const auto& [id, entity] : entities_) {
      if (entity.type != "PRESENTATION_LAYER_ASSIGNMENT" || entity.name.empty()) continue;
      const std::string layer = normalizeStepName(entity.name);
      for (const auto& ref : entity.refs) {
        const auto target = entities_.find(ref);
        if (target == entities_.end() || target->second.type != "MANIFOLD_SOLID_BREP") continue;
        const std::string name = normalizeDisplayWhitespace(target->second.name);
        if (isRawLabelName(name)) continue;
        namedBrepTargetsByLayer_[layer].push_back({stepEntityNumericId(ref), name});
      }
    }
    for (auto& [layer, targets] : namedBrepTargetsByLayer_) {
      std::sort(targets.begin(), targets.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    }
  }

  void buildProductNameIndex() {
    std::set<std::string> names;
    for (const auto& [id, entity] : entities_) {
      if (entity.type != "PRODUCT") {
        continue;
      }
      const auto parts = splitTopLevel(entity.args);
      for (std::size_t i = 0; i < std::min<std::size_t>(2, parts.size()); ++i) {
        const std::string name = normalizeDisplayWhitespace(unquoteStepString(parts[i]));
        if (!isRawLabelName(name)) {
          names.insert(name);
          break;
        }
      }
    }
    productNameCandidates_.assign(names.begin(), names.end());
    if (productNameCandidates_.size() == 1) {
      uniqueProductName_ = productNameCandidates_.front();
    }
  }

  void buildStyledItemIndex() {
    for (const auto& [id, entity] : entities_) {
      if (entity.type == "COLOUR_RGB") {
        colourCount_ += 1;
      }
      if (entity.type != "STYLED_ITEM") {
        continue;
      }
      styledItemCount_ += 1;
      const auto colourIds = findColoursFromStyledItem(entities_, id);
      if (colourIds.empty()) {
        continue;
      }
      Colour colour;
      const auto colourEntity = entities_.find(colourIds.front());
      if (colourEntity == entities_.end() || !colourFromStepEntity(colourEntity->second, colour)) {
        continue;
      }
      const auto refs = entity.refs;
      for (const auto& ref : refs) {
        const auto target = entities_.find(ref);
        if (target == entities_.end() || target->second.type == "PRESENTATION_STYLE_ASSIGNMENT") {
          continue;
        }
        RawStepStyleMatch match;
        match.colour = colour;
        match.colourId = colourIds.front();
        match.styledItemId = id;
        match.styledTargetId = ref;
        match.styledTargetType = target->second.type;
        match.styledTargetScope = rawStyleTargetScope(target->second.type);
        match.styledTargetName = normalizeDisplayWhitespace(target->second.name);
        match.confidence = rawStyleConfidenceForTarget(target->second.type);
        match.colour.lookupPath = id + " -> " + ref + " -> " + colourIds.front();
        match.path = match.colour.lookupPath;
        styledByTarget_[ref].push_back(match);
        auto& audit = colourAudit_[colourIds.front()];
        audit.colourId = colourIds.front();
        audit.colour = colour;
        audit.styledItemIds.push_back(id);
      }
    }
  }

  void buildRepresentationIndex() {
    for (const auto& [id, entity] : entities_) {
      if (!isRepresentationEntity(entity.type) || entity.name.empty()) {
        continue;
      }
      std::set<std::string> seen{id};
      std::deque<std::pair<std::string, std::vector<std::string>>> queue;
      queue.push_back({id, {id}});
      while (!queue.empty()) {
        const auto [current, path] = queue.front();
        queue.pop_front();
        if (path.size() > 8) {
          continue;
        }
        const auto currentEntity = entities_.find(current);
        if (currentEntity == entities_.end()) {
          continue;
        }
        std::vector<std::string> neighbours = currentEntity->second.refs;
        const auto reverseFound = reverseRefs_.find(current);
        if (reverseFound != reverseRefs_.end()) {
          for (const auto& reverseRef : reverseFound->second) {
            const auto reverseEntity = entities_.find(reverseRef);
            if (reverseEntity == entities_.end()) {
              continue;
            }
            const bool isRepresentationBridge =
                reverseEntity->second.type.find("SHAPE_REPRESENTATION_RELATIONSHIP") != std::string::npos ||
                reverseEntity->second.type == "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION";
            if (!isRepresentationBridge) {
              continue;
            }
            neighbours.push_back(reverseRef);
          }
        }
        for (const auto& neighbour : neighbours) {
          if (!seen.insert(neighbour).second) {
            continue;
          }
          const auto neighbourEntity = entities_.find(neighbour);
          if (neighbourEntity == entities_.end()) {
            continue;
          }
          const std::string& type = neighbourEntity->second.type;
          const bool canTraverse = isRepresentationEntity(type) ||
                                   isBrepOrTopologyEntity(type) ||
                                   type.find("PLACEMENT") != std::string::npos ||
                                   type.find("TRANSFORMATION") != std::string::npos;
          if (!canTraverse) {
            continue;
          }
          std::vector<std::string> nextPath = path;
          nextPath.push_back(neighbour);
          const auto styledFound = styledByTarget_.find(neighbour);
          if (styledFound != styledByTarget_.end()) {
            for (auto match : styledFound->second) {
              match.representationId = id;
              match.representationName = entity.name;
              match.path = pathToString(nextPath, entities_) + " -> " + match.styledItemId + " STYLED_ITEM";
              match.colour.lookupPath = match.path;
              if (match.confidence == "weak/name-only match") {
                match.confidence = rawStyleConfidenceForTarget(match.styledTargetType);
              }
              const std::string key = normalizeStepName(entity.name);
              matchesByNormalizedRepresentationName_[key].push_back(match);
              auto auditFound = colourAudit_.find(match.colourId);
              if (auditFound != colourAudit_.end()) {
                auditFound->second.mappedObjectNames.push_back(entity.name);
              }
              representationColourCount_ += 1;
            }
          }
          queue.push_back({neighbour, nextPath});
        }
      }
    }
  }

  std::map<std::string, RawStepEntity> entities_;
  std::map<std::string, std::vector<std::string>> reverseRefs_;
  std::map<std::string, std::vector<RawStepStyleMatch>> styledByTarget_;
  std::map<std::string, std::vector<RawStepStyleMatch>> matchesByNormalizedRepresentationName_;
  std::map<std::string, RawStepColourAudit> colourAudit_;
  std::map<std::string, std::vector<std::pair<int, std::string>>> namedBrepTargetsByLayer_;
  std::vector<std::string> productNameCandidates_;
  std::string uniqueProductName_;
  int styledItemCount_ = 0;
  int colourCount_ = 0;
  int representationColourCount_ = 0;
};

bool containsDiagnosticKeyword(const MeshPrimitive& primitive) {
  const std::string haystack = lowerAscii(
      primitive.displayName + " " + primitive.instancePath + " " + primitive.originalStepName + " " + primitive.layer);
  for (const std::string keyword : {
           "valve", "diaphragm", "k30", "vcr", "gauge", "regulator", "fitting", "tube", "pipe", "support"}) {
    if (haystack.find(keyword) != std::string::npos) {
      return true;
    }
  }
  return false;
}

std::string transformSummary(const TopLoc_Location& location) {
  if (location.IsIdentity()) {
    return "identity";
  }

  const gp_Trsf transform = location.Transformation();
  std::ostringstream out;
  out << std::fixed << std::setprecision(6);
  out << "[";
  for (int row = 1; row <= 3; ++row) {
    if (row > 1) out << "; ";
    out << transform.Value(row, 1) << "," << transform.Value(row, 2) << "," << transform.Value(row, 3)
        << "," << transform.Value(row, 4);
  }
  out << "]";
  return out.str();
}

TopLoc_Location shapeLocation(const Handle(XCAFDoc_ShapeTool)& shapeTool, const TDF_Label& label) {
  TopoDS_Shape shape;
  shapeTool->GetShape(label, shape);
  return shape.IsNull() ? TopLoc_Location() : shape.Location();
}

double bboxDiagonal(const MeshPrimitive& primitive) {
  const double dx = static_cast<double>(primitive.max[0]) - primitive.min[0];
  const double dy = static_cast<double>(primitive.max[1]) - primitive.min[1];
  const double dz = static_cast<double>(primitive.max[2]) - primitive.min[2];
  return std::sqrt(dx * dx + dy * dy + dz * dz);
}

std::array<float, 3> emptyMinBounds() {
  return {
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max()};
}

std::array<float, 3> emptyMaxBounds() {
  return {
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest()};
}

void writeVec3(std::ostream& out, const std::array<float, 3>& value) {
  out << "[" << value[0] << ", " << value[1] << ", " << value[2] << "]";
}

bool readLabelColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label,
    const XCAFDoc_ColorType type,
    const std::string& source,
    const std::string& materialSource,
    const std::string& colourType,
    Colour& colour) {
  Quantity_ColorRGBA rgba;
  if (colourTool->GetColor(label, type, rgba)) {
    colour.r = rgba.GetRGB().Red();
    colour.g = rgba.GetRGB().Green();
    colour.b = rgba.GetRGB().Blue();
    colour.a = rgba.Alpha();
    colour.source = source;
    colour.materialSource = materialSource;
    colour.lookupPath = labelEntry(label);
    colour.colourType = colourType;
    colour.fallbackReason.clear();
    return true;
  }

  Quantity_Color rgb;
  if (colourTool->GetColor(label, type, rgb)) {
    colour.r = rgb.Red();
    colour.g = rgb.Green();
    colour.b = rgb.Blue();
    colour.a = 1.0;
    colour.source = source;
    colour.materialSource = materialSource;
    colour.lookupPath = labelEntry(label);
    colour.colourType = colourType;
    colour.fallbackReason.clear();
    return true;
  }

  return false;
}

bool readShapeColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TopoDS_Shape& shape,
    const XCAFDoc_ColorType type,
    const std::string& source,
    const std::string& materialSource,
    const std::string& lookupPath,
    const std::string& colourType,
    Colour& colour) {
  Quantity_ColorRGBA rgba;
  if (colourTool->GetColor(shape, type, rgba)) {
    colour.r = rgba.GetRGB().Red();
    colour.g = rgba.GetRGB().Green();
    colour.b = rgba.GetRGB().Blue();
    colour.a = rgba.Alpha();
    colour.source = source;
    colour.materialSource = materialSource;
    colour.lookupPath = lookupPath;
    colour.colourType = colourType;
    colour.fallbackReason.clear();
    return true;
  }

  Quantity_Color rgb;
  if (colourTool->GetColor(shape, type, rgb)) {
    colour.r = rgb.Red();
    colour.g = rgb.Green();
    colour.b = rgb.Blue();
    colour.a = 1.0;
    colour.source = source;
    colour.materialSource = materialSource;
    colour.lookupPath = lookupPath;
    colour.colourType = colourType;
    colour.fallbackReason.clear();
    return true;
  }

  return false;
}

bool firstColourForLabel(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label,
    const std::string& prefix,
    const std::string& materialSource,
    Colour& colour) {
  if (label.IsNull()) {
    return false;
  }

  std::string entry = labelEntry(label);

  auto found = labelColorCache.find(entry);
  if (found != labelColorCache.end()) {
    labelColorCacheHits++;
    if (found->second.source == "NO_COLOUR") {
      return false;
    }
    colour = found->second;
    colour.source = prefix + colour.colourType;
    colour.materialSource = materialSource;
    return true;
  }

  labelColorCacheMisses++;
  for (const auto& item : std::vector<std::pair<XCAFDoc_ColorType, std::string>>{
           {XCAFDoc_ColorSurf, "surface"},
           {XCAFDoc_ColorGen, "generic"},
           {XCAFDoc_ColorCurv, "curve"}}) {
    Colour queriedColour;
    if (readLabelColour(colourTool, label, item.first, prefix + item.second, materialSource, item.second, queriedColour)) {
      labelColorCache[entry] = queriedColour;
      colour = queriedColour;
      return true;
    }
  }

  Colour sentinel;
  sentinel.source = "NO_COLOUR";
  labelColorCache[entry] = sentinel;
  return false;
}

void buildColorCache(const Handle(XCAFDoc_ColorTool)& colourTool, const Handle(XCAFDoc_ShapeTool)& shapeTool) {
  std::set<std::string> visitedLabels;
  
  auto processLabel = [&](const TDF_Label& label) {
    const std::string entry = labelEntry(label);
    if (visitedLabels.find(entry) != visitedLabels.end()) {
      return;
    }
    visitedLabels.insert(entry);
    
    TopoDS_Shape S = shapeTool->GetShape(label);
    if (!S.IsNull() && S.TShape()) {
      for (auto type : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen, XCAFDoc_ColorCurv}) {
        Quantity_ColorRGBA rgba;
        if (colourTool->GetColor(label, type, rgba)) {
          Colour c;
          c.r = rgba.GetRGB().Red();
          c.g = rgba.GetRGB().Green();
          c.b = rgba.GetRGB().Blue();
          c.a = rgba.Alpha();
          c.source = "cached_shape_colour";
          c.materialSource = "face/subshape";
          c.lookupPath = entry;
          c.colourType = (type == XCAFDoc_ColorSurf ? "surface" : (type == XCAFDoc_ColorGen ? "generic" : "curve"));
          c.fallbackReason.clear();
          shapeColorCache[{S.TShape().get(), type}] = c;
        } else {
          Quantity_Color rgb;
          if (colourTool->GetColor(label, type, rgb)) {
            Colour c;
            c.r = rgb.Red();
            c.g = rgb.Green();
            c.b = rgb.Blue();
            c.a = 1.0;
            c.source = "cached_shape_colour";
            c.materialSource = "face/subshape";
            c.lookupPath = entry;
            c.colourType = (type == XCAFDoc_ColorSurf ? "surface" : (type == XCAFDoc_ColorGen ? "generic" : "curve"));
            c.fallbackReason.clear();
            shapeColorCache[{S.TShape().get(), type}] = c;
          }
        }
      }
    }
  };

  TDF_LabelSequence shapes;
  shapeTool->GetShapes(shapes);
  for (Standard_Integer i = 1; i <= shapes.Length(); ++i) {
    TDF_Label mainLabel = shapes.Value(i);
    processLabel(mainLabel);
    for (TDF_ChildIterator it(mainLabel, Standard_True); it.More(); it.Next()) {
      processLabel(it.Value());
    }
  }

  TDF_LabelSequence freeShapes;
  shapeTool->GetFreeShapes(freeShapes);
  for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
    TDF_Label mainLabel = freeShapes.Value(i);
    processLabel(mainLabel);
    for (TDF_ChildIterator it(mainLabel, Standard_True); it.More(); it.Next()) {
      processLabel(it.Value());
    }
  }
}

bool firstColourForShape(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TopoDS_Shape& shape,
    const std::string& prefix,
    const std::string& materialSource,
    const std::string& lookupPath,
    Colour& colour) {
  if (!globalDisableStyleCache && shape.TShape()) {
    auto* tshapePtr = shape.TShape().get();
    bool hasSurf = shapeColorCache.find({tshapePtr, XCAFDoc_ColorSurf}) != shapeColorCache.end();
    bool hasGen = shapeColorCache.find({tshapePtr, XCAFDoc_ColorGen}) != shapeColorCache.end();
    bool hasCurv = shapeColorCache.find({tshapePtr, XCAFDoc_ColorCurv}) != shapeColorCache.end();

    if (hasSurf || hasGen || hasCurv) {
      for (auto type : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen, XCAFDoc_ColorCurv}) {
        auto found = shapeColorCache.find({tshapePtr, type});
        if (found != shapeColorCache.end()) {
          shapeColorCacheHits++;
          if (found->second.source != "NO_COLOUR") {
            colour = found->second;
            colour.source = prefix + (type == XCAFDoc_ColorSurf ? "surface" : (type == XCAFDoc_ColorGen ? "generic" : "curve"));
            colour.materialSource = materialSource;
            colour.lookupPath = lookupPath;
            colour.colourType = (type == XCAFDoc_ColorSurf ? "surface" : (type == XCAFDoc_ColorGen ? "generic" : "curve"));
            colour.fallbackReason.clear();
            return true;
          }
        }
      }
      return false;
    }

    shapeColorCacheMisses++;
    bool foundAny = false;
    for (const auto& item : std::vector<std::pair<XCAFDoc_ColorType, std::string>>{
             {XCAFDoc_ColorSurf, "surface"},
             {XCAFDoc_ColorGen, "generic"},
             {XCAFDoc_ColorCurv, "curve"}}) {
      Colour queriedColour;
      if (readShapeColour(colourTool, shape, item.first, prefix + item.second, materialSource, lookupPath, item.second, queriedColour)) {
        shapeColorCache[{tshapePtr, item.first}] = queriedColour;
        if (!foundAny) {
          colour = queriedColour;
          foundAny = true;
        }
      } else {
        Colour sentinel;
        sentinel.source = "NO_COLOUR";
        shapeColorCache[{tshapePtr, item.first}] = sentinel;
      }
    }
    return foundAny;
  }

  for (const auto& item : std::vector<std::pair<XCAFDoc_ColorType, std::string>>{
           {XCAFDoc_ColorSurf, "surface"},
           {XCAFDoc_ColorGen, "generic"},
           {XCAFDoc_ColorCurv, "curve"}}) {
    if (readShapeColour(colourTool, shape, item.first, prefix + item.second, materialSource, lookupPath, item.second, colour)) {
      return true;
    }
  }
  return false;
}

std::vector<LayerInfo> collectLayerInfos(
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& label) {
  std::vector<LayerInfo> layers;
  TDF_LabelSequence layerLabels;
  layerTool->GetLayers(label, layerLabels);
  for (Standard_Integer i = 1; i <= layerLabels.Length(); ++i) {
    const std::string name = labelName(layerLabels.Value(i));
    layers.push_back({name.empty() ? labelEntry(layerLabels.Value(i)) : name, layerLabels.Value(i)});
  }
  std::sort(layers.begin(), layers.end(), [](const LayerInfo& a, const LayerInfo& b) {
    return a.name < b.name;
  });
  layers.erase(std::unique(layers.begin(), layers.end(), [](const LayerInfo& a, const LayerInfo& b) {
    return a.name == b.name;
  }), layers.end());
  return layers;
}

std::vector<LayerInfo> collectLabelAndReferredLayers(
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& label,
    const TDF_Label& referred) {
  auto layers = collectLayerInfos(layerTool, label);
  if (layers.empty() && !referred.IsNull()) {
    layers = collectLayerInfos(layerTool, referred);
  }
  return layers;
}

std::string firstLayerName(const std::vector<LayerInfo>& layers) {
  return layers.empty() ? "" : layers.front().name;
}

bool layerColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const std::vector<LayerInfo>& layers,
    Colour& colour);

Quality parseQuality(const std::string& value) {
  if (value == "high") {
    return {"high", 0.12, 0.22, true};
  }
  if (value == "balanced") {
    return {"balanced", 0.45, 0.50, true};
  }
  if (value == "preview") {
    return {"preview", 0.85, 0.65, true};
  }
  throw std::runtime_error("Unsupported quality preset: " + value);
}

ColourSpaceConfig parseColourSpace(const std::string& value) {
  if (value == "raw") {
    return {ColourSpaceMode::Raw, "raw"};
  }
  if (value == "srgb-to-linear") {
    return {ColourSpaceMode::SrgbToLinear, "srgb-to-linear"};
  }
  throw std::runtime_error("Unsupported colour-space mode: " + value);
}

ColourModeConfig parseColourMode(const std::string& value) {
  if (value == "experimental") {
    return {ColourMode::Experimental, "experimental", true, true};
  }
  if (value == "xcaf-baseline") {
    return {ColourMode::XcafBaseline, "xcaf-baseline", false, false};
  }
  if (value == "step-presentation" || value == "xcaf-step-presentation") {
    return {ColourMode::StepPresentation, "step-presentation", true, false};
  }
  throw std::runtime_error("Unsupported colour-mode: " + value);
}

struct CliOptions {
  ColourSpaceConfig colourSpace = parseColourSpace("raw");
  ColourModeConfig colourMode = parseColourMode("experimental");
  bool parallelMesh = true;
  bool debugSuperCoarseMesh = false;
  bool debugSkipRawStepStyles = false;
  bool debugDisableStyleCache = false;
  bool debugLegacyTransform = false;
  bool enableMeshReuse = false;
  bool generatePrototypeReport = false;
};

CliOptions parseCliOptions(const int argc, char** argv, const int startIndex) {
  CliOptions options;
  for (int i = startIndex; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--colour-space") {
      if (i + 1 >= argc) {
        throw std::runtime_error("--colour-space requires raw or srgb-to-linear");
      }
      options.colourSpace = parseColourSpace(argv[++i]);
    } else if (arg.rfind("--colour-space=", 0) == 0) {
      options.colourSpace = parseColourSpace(arg.substr(std::string("--colour-space=").size()));
    } else if (arg == "--colour-mode") {
      if (i + 1 >= argc) {
        throw std::runtime_error("--colour-mode requires experimental, xcaf-baseline, or step-presentation");
      }
      options.colourMode = parseColourMode(argv[++i]);
    } else if (arg.rfind("--colour-mode=", 0) == 0) {
      options.colourMode = parseColourMode(arg.substr(std::string("--colour-mode=").size()));
    } else if (arg == "--parallel-mesh") {
      if (i + 1 >= argc) {
        throw std::runtime_error("--parallel-mesh requires on or off");
      }
      std::string val = argv[++i];
      options.parallelMesh = (val == "on");
    } else if (arg.rfind("--parallel-mesh=", 0) == 0) {
      std::string val = arg.substr(std::string("--parallel-mesh=").size());
      options.parallelMesh = (val == "on");
    } else if (arg == "--debug-super-coarse-mesh") {
      options.debugSuperCoarseMesh = true;
    } else if (arg == "--debug-skip-raw-step-styles") {
      options.debugSkipRawStepStyles = true;
    } else if (arg == "--debug-disable-style-cache") {
      options.debugDisableStyleCache = true;
    } else if (arg == "--debug-legacy-transform") {
      options.debugLegacyTransform = true;
    } else if (arg == "--enable-mesh-reuse") {
      options.enableMeshReuse = true;
    } else if (arg == "--debug-disable-mesh-reuse") {
      options.enableMeshReuse = false;
    } else if (arg == "--generate-prototype-report") {
      options.generatePrototypeReport = true;
    } else {
      throw std::runtime_error("Unknown argument: " + arg);
    }
  }
  return options;
}

std::array<float, 3> normalFromTriangle(
    const std::array<float, 3>& a,
    const std::array<float, 3>& b,
    const std::array<float, 3>& c) {
  const float ux = b[0] - a[0];
  const float uy = b[1] - a[1];
  const float uz = b[2] - a[2];
  const float vx = c[0] - a[0];
  const float vy = c[1] - a[1];
  const float vz = c[2] - a[2];
  float nx = uy * vz - uz * vy;
  float ny = uz * vx - ux * vz;
  float nz = ux * vy - uy * vx;
  const float length = std::sqrt(nx * nx + ny * ny + nz * nz);
  if (length > 0.0f) {
    nx /= length;
    ny /= length;
    nz /= length;
  }
  return {nx, ny, nz};
}

void appendVertex(MeshPrimitive& primitive, const std::array<float, 3>& position, const std::array<float, 3>& normal) {
  for (int i = 0; i < 3; ++i) {
    primitive.min[i] = std::min(primitive.min[i], position[i]);
    primitive.max[i] = std::max(primitive.max[i], position[i]);
  }
  primitive.positions.insert(primitive.positions.end(), position.begin(), position.end());
  primitive.normals.insert(primitive.normals.end(), normal.begin(), normal.end());
}

void appendFaceTriangles(MeshPrimitive& primitive, const TopoDS_Face& face) {
  TopLoc_Location loc;
  Handle(Poly_Triangulation) triangulation = BRep_Tool::Triangulation(face, loc);
  if (triangulation.IsNull()) {
    return;
  }

  const gp_Trsf transform = loc.Transformation();
  for (Standard_Integer i = 1; i <= triangulation->NbTriangles(); ++i) {
    Standard_Integer n1 = 0;
    Standard_Integer n2 = 0;
    Standard_Integer n3 = 0;
    triangulation->Triangle(i).Get(n1, n2, n3);
    if (face.Orientation() == TopAbs_REVERSED) {
      std::swap(n2, n3);
    }

    std::array<std::array<float, 3>, 3> positions;
    const std::array<Standard_Integer, 3> nodeIds = {n1, n2, n3};
    for (int n = 0; n < 3; ++n) {
      gp_Pnt p = triangulation->Node(nodeIds[n]);
      p.Transform(transform);
      positions[n] = {
          static_cast<float>(p.X()),
          static_cast<float>(p.Y()),
          static_cast<float>(p.Z())};
    }

    const auto normal = normalFromTriangle(positions[0], positions[1], positions[2]);
    const std::uint32_t base = static_cast<std::uint32_t>(primitive.positions.size() / 3);
    appendVertex(primitive, positions[0], normal);
    appendVertex(primitive, positions[1], normal);
    appendVertex(primitive, positions[2], normal);
    primitive.indices.push_back(base);
    primitive.indices.push_back(base + 1);
    primitive.indices.push_back(base + 2);
  }
}

TopoDS_Shape shapeForLabel(const Handle(XCAFDoc_ShapeTool)& shapeTool, const TDF_Label& label, TDF_Label& referred) {
  TopoDS_Shape shape;
  referred.Nullify();
  if (shapeTool->IsReference(label) && shapeTool->GetReferredShape(label, referred)) {
    shapeTool->GetShape(label, shape);
    if (!shape.IsNull()) {
      return shape;
    }
    shapeTool->GetShape(referred, shape);
    return shape;
  }
  shapeTool->GetShape(label, shape);
  return shape;
}

void collectColouredSubshapes(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& root,
    const std::string& sourcePrefix,
    std::vector<SubshapeColourCandidate>& candidates) {
  if (root.IsNull()) {
    return;
  }

  for (TDF_ChildIterator it(root, Standard_True); it.More(); it.Next()) {
    const TDF_Label child = it.Value();
    if (!shapeTool->IsShape(child)) {
      continue;
    }

    TopoDS_Shape childShape;
    shapeTool->GetShape(child, childShape);
    if (childShape.IsNull()) {
      continue;
    }

    const auto childLayers = collectLayerInfos(layerTool, child);
    Colour colour;
    const bool hasColour =
        firstColourForLabel(colourTool, child, sourcePrefix + "_label_", "face/subshape", colour) ||
        firstColourForShape(colourTool, childShape, sourcePrefix + "_shape_", "face/subshape", labelEntry(child), colour);
    Colour childLayerColour;
    const bool hasLayerColour = layerColour(colourTool, childLayers, childLayerColour);

    if (hasColour) {
      candidates.push_back({
          childShape,
          labelEntry(child),
          safeName(labelName(child), labelEntry(child)),
          isRawLabelName(labelName(child)) ? "" : "xcaf-subshape",
          childLayers,
          colour,
          hasColour,
          childLayerColour,
          hasLayerColour});
    } else if (!childLayers.empty() || hasLayerColour) {
      candidates.push_back({
          childShape,
          labelEntry(child),
          safeName(labelName(child), labelEntry(child)),
          isRawLabelName(labelName(child)) ? "" : "xcaf-subshape",
          childLayers,
          colour,
          false,
          childLayerColour,
          hasLayerColour});
    }
  }
}

bool matchingSubshapeColour(
    const TopoDS_Face& face,
    const std::vector<SubshapeColourCandidate>& candidates,
    const std::unordered_map<TopoDS_TShape*, size_t>& subshapeFaceCache,
    const bool useCache,
    Colour& colour,
    std::vector<LayerInfo>& layers,
    bool& matchedHasColour,
    bool& matchedHasLayerColour,
    Colour& matchedLayerColour,
    std::string& matchedLabelPath,
    std::string& matchedName,
    std::string& matchedNameSource) {
  if (useCache && face.TShape()) {
    auto found = subshapeFaceCache.find(face.TShape().get());
    if (found != subshapeFaceCache.end()) {
      subshapeCacheHits++;
      size_t idx = found->second;
      const auto& candidate = candidates[idx];
      colour = candidate.colour;
      if (colour.lookupPath.empty()) {
        colour.lookupPath = candidate.labelPath;
      }
      layers = candidate.layers;
      matchedHasColour = candidate.hasColour;
      matchedHasLayerColour = candidate.hasLayerColour;
      matchedLayerColour = candidate.layerColour;
      matchedLabelPath = candidate.labelPath;
      matchedName = isRawLabelName(candidate.displayName) ? "" : normalizeDisplayWhitespace(candidate.displayName);
      matchedNameSource = matchedName.empty() ? "" : candidate.nameSource;
      return true;
    }
    subshapeCacheMisses++;
    return false;
  }

  for (const auto& candidate : candidates) {
    if (face.IsSame(candidate.shape)) {
      colour = candidate.colour;
      if (colour.lookupPath.empty()) {
        colour.lookupPath = candidate.labelPath;
      }
      layers = candidate.layers;
      matchedHasColour = candidate.hasColour;
      matchedHasLayerColour = candidate.hasLayerColour;
      matchedLayerColour = candidate.layerColour;
      matchedLabelPath = candidate.labelPath;
      matchedName = isRawLabelName(candidate.displayName) ? "" : normalizeDisplayWhitespace(candidate.displayName);
      matchedNameSource = matchedName.empty() ? "" : candidate.nameSource;
      return true;
    }
    for (TopExp_Explorer explorer(candidate.shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
      if (face.IsSame(TopoDS::Face(explorer.Current()))) {
        colour = candidate.colour;
        if (colour.lookupPath.empty()) {
          colour.lookupPath = candidate.labelPath;
        }
        layers = candidate.layers;
        matchedHasColour = candidate.hasColour;
        matchedHasLayerColour = candidate.hasLayerColour;
        matchedLayerColour = candidate.layerColour;
        matchedLabelPath = candidate.labelPath;
        matchedName = isRawLabelName(candidate.displayName) ? "" : normalizeDisplayWhitespace(candidate.displayName);
        matchedNameSource = matchedName.empty() ? "" : candidate.nameSource;
        return true;
      }
    }
  }
  return false;
}

Colour defaultColour(
    const std::string& reason,
    const std::string& lookupPath) {
  Colour colour;
  colour.source = "default_neutral_grey";
  colour.materialSource = "default";
  colour.lookupPath = lookupPath;
  colour.colourType = "none";
  colour.fallbackReason = reason;
  return colour;
}

Colour inheritedColourForChild(const Colour& inheritedColour) {
  Colour colour = inheritedColour;
  colour.source = "ancestor_" + inheritedColour.source;
  colour.materialSource = "ancestor";
  return colour;
}

bool nearestAncestorColour(
    const bool hasInheritedColour,
    const Colour& inheritedColour,
    Colour& colour) {
  if (!hasInheritedColour) {
    return false;
  }
  colour = inheritedColourForChild(inheritedColour);
  return true;
}

bool layerColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const std::vector<LayerInfo>& layers,
    Colour& colour) {
  for (const auto& layer : layers) {
    if (firstColourForLabel(colourTool, layer.label, "layer_", "layer", colour)) {
      if (colour.lookupPath.empty()) {
        colour.lookupPath = labelEntry(layer.label);
      }
      return true;
    }
  }
  return false;
}

bool findLabelColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label,
    Colour& colour) {
  if (firstColourForLabel(colourTool, label, "label_", "label", colour)) {
    return true;
  }
  return false;
}

bool referredLabelColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& referred,
    Colour& colour) {
  if (!referred.IsNull() &&
      firstColourForLabel(colourTool, referred, "referred_label_", "referred label", colour)) {
    return true;
  }
  return false;
}

std::vector<TopoDS_Shape> directSubshapesOfType(const TopoDS_Shape& shape, const TopAbs_ShapeEnum type) {
  std::vector<TopoDS_Shape> result;
  if (shape.ShapeType() == type) {
    result.push_back(shape);
    return result;
  }
  for (TopExp_Explorer explorer(shape, type); explorer.More(); explorer.Next()) {
    result.push_back(explorer.Current());
  }
  return result;
}

TopAbs_ShapeEnum preferredShapeTypeForStyledMatches(const std::vector<RawStepStyleMatch>& matches) {
  bool hasShell = false;
  bool hasSolid = false;
  for (const auto& match : matches) {
    if (match.styledTargetType.find("SHELL") != std::string::npos) {
      hasShell = true;
    } else if (match.styledTargetType.find("BREP") != std::string::npos ||
               match.styledTargetType.find("SOLID") != std::string::npos) {
      hasSolid = true;
    }
  }
  if (hasShell && !hasSolid) {
    return TopAbs_SHELL;
  }
  return TopAbs_SOLID;
}

std::vector<StyledTopologyColour> mapStepPresentationToSubshapes(
    const RawStepStyleResolver* rawStepStyles,
    const ColourModeConfig& colourMode,
    const TopoDS_Shape& sourceShape,
    const std::vector<std::string>& names,
    RawStepStyleMatch& rejectedMatch) {
  if (rawStepStyles == nullptr || colourMode.mode != ColourMode::StepPresentation) {
    return {};
  }
  std::vector<RawStepStyleMatch> matches = rawStepStyles->strongTopologyMatchesForNames(names, rejectedMatch);
  if (matches.empty()) {
    matches = rawStepStyles->uniqueStrongTopologyRepresentationGroup(rejectedMatch);
    for (auto& match : matches) {
      match.confidence = match.confidence + "; unique styled representation group";
    }
  }
  if (matches.empty()) {
    return {};
  }

  TopAbs_ShapeEnum subshapeType = preferredShapeTypeForStyledMatches(matches);
  std::vector<TopoDS_Shape> subshapes = directSubshapesOfType(sourceShape, subshapeType);
  if (subshapes.size() != matches.size() && subshapeType == TopAbs_SOLID) {
    subshapeType = TopAbs_SHELL;
    subshapes = directSubshapesOfType(sourceShape, subshapeType);
  }
  if (subshapes.size() != matches.size()) {
    rejectedMatch = matches.front();
    rejectedMatch.representationCandidateCount = static_cast<int>(matches.size());
    rejectedMatch.rejectedReason =
        "strong STEP styled targets found, but exported topology count did not match; targetCount=" +
        std::to_string(matches.size()) + " exportedSubshapeCount=" + std::to_string(subshapes.size());
    return {};
  }

  std::vector<StyledTopologyColour> mapped;
  for (std::size_t i = 0; i < matches.size(); ++i) {
    auto match = matches[i];
    match.colour = linearizedStepPresentationColour(match.colour);
    match.colour.source = "step_presentation_styled_item";
    match.colour.materialSource = "step_presentation_styled_item";
    match.colour.lookupPath = match.path;
    match.colour.fallbackReason = "confidence=" + match.confidence +
        " styledItem=" + match.styledItemId +
        " target=" + match.styledTargetId +
        " targetType=" + match.styledTargetType +
        " targetScope=" + match.styledTargetScope;
    mapped.push_back({subshapes[i], match, "compound split by styled BREP"});
  }
  return mapped;
}

bool stepPresentationColourForFace(
    const TopoDS_Face& face,
    const std::vector<StyledTopologyColour>& styledTopologyColours,
    const std::unordered_map<TopoDS_TShape*, size_t>& styledFaceCache,
    const bool useCache,
    RawStepStyleMatch& match,
    std::string& geometrySource) {
  if (useCache && face.TShape()) {
    auto found = styledFaceCache.find(face.TShape().get());
    if (found != styledFaceCache.end()) {
      styleCacheHits++;
      size_t idx = found->second;
      match = styledTopologyColours[idx].match;
      geometrySource = styledTopologyColours[idx].geometrySource;
      return true;
    }
    styleCacheMisses++;
    return false;
  }

  for (const auto& candidate : styledTopologyColours) {
    if (face.IsSame(candidate.shape)) {
      match = candidate.match;
      geometrySource = candidate.geometrySource;
      return true;
    }
    for (TopExp_Explorer explorer(candidate.shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
      if (face.IsSame(TopoDS::Face(explorer.Current()))) {
        match = candidate.match;
        geometrySource = candidate.geometrySource;
        return true;
      }
    }
  }
  return false;
}

void tessellateLabel(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const RawStepStyleResolver* rawStepStyles,
    const CliOptions& cliOptions,
    const TDF_Label& label,
    const Quality& quality,
    const std::string& instancePath,
    const TopLoc_Location& parentAccumulatedLocation,
    const std::string& transformSource,
    const bool hasInheritedColour,
    const Colour& inheritedColour,
    const std::vector<LayerInfo>& inheritedLayers,
    const std::string& parentChain,
    const std::string& parentDisplayName,
    const std::string& parentProductName,
    std::vector<MeshPrimitive>& primitives,
    Stats& stats) {
  stats.labelsProcessed += 1;
  TDF_Label referred;
  TopoDS_Shape sourceShape = shapeForLabel(shapeTool, label, referred);
  if (sourceShape.IsNull()) {
    stats.skippedShapes += 1;
    return;
  }
  const TopLoc_Location localLocation = sourceShape.Location();
  const TopLoc_Location childAccumulatedLocation = parentAccumulatedLocation * localLocation;

  TopoDS_Shape renderShape = sourceShape;
  if (cliOptions.debugLegacyTransform) {
    if (!childAccumulatedLocation.IsIdentity()) {
      renderShape = sourceShape.Moved(childAccumulatedLocation);
    }
  } else {
    if (!parentAccumulatedLocation.IsIdentity()) {
      renderShape = sourceShape.Moved(parentAccumulatedLocation);
    }
  }

  // --- Transform Contract Documentation ---
  // Vertices are baked into world coordinates during triangulation.
  // The GLB writer writes identity node transforms (nodes have no translation/rotation/scale matrix).
  // This is Option A (flattened, baked coordinates) to avoid double-transformation bugs.
  // For the fixed path, we apply the parent's accumulated location to the shape's local location.
  // For the legacy path, we compound the child's accumulated location with the shape's local location,
  // which causes the local transform to be applied twice.
  // ----------------------------------------

  // Transform Audit Logging (first 20 non-identity / 3 identity)
  static int auditCount = 0;
  bool shouldAudit = false;
  if (!localLocation.IsIdentity() && auditCount < 20) {
    auditCount++;
    shouldAudit = true;
  } else if (localLocation.IsIdentity() && auditCount < 3) {
    auditCount++;
    shouldAudit = true;
  }

  if (shouldAudit) {
    logLine("[TRANSFORM_AUDIT #" + std::to_string(auditCount) + "] Path: " + (instancePath.empty() ? labelEntry(label) : instancePath));
    logLine("  - localLocation: " + transformSummary(localLocation));
    logLine("  - parent accumulatedLocation: " + transformSummary(parentAccumulatedLocation));
    logLine("  - childAccumulatedLocation (parent * local): " + transformSummary(childAccumulatedLocation));
    logLine("  - sourceShape.Location(): " + transformSummary(sourceShape.Location()));
    logLine("  - renderShape.Location(): " + transformSummary(renderShape.Location()));
    logLine("  - transform mode: " + std::string(cliOptions.debugLegacyTransform ? "legacy (incorrect)" : "fixed (correct)"));
    logLine("  - final GLB/node transform contract: identity (vertices baked in world coordinates)");
  }

  // Nested Transform Audit Logging (first 10 where parent is non-identity)
  static int nestedAuditCount = 0;
  if (!parentAccumulatedLocation.IsIdentity() && nestedAuditCount < 10) {
    nestedAuditCount++;
    logLine("[TRANSFORM_AUDIT_NESTED #" + std::to_string(nestedAuditCount) + "] Path: " + (instancePath.empty() ? labelEntry(label) : instancePath));
    logLine("  - localLocation: " + transformSummary(localLocation));
    logLine("  - parent accumulatedLocation: " + transformSummary(parentAccumulatedLocation));
    logLine("  - childAccumulatedLocation (parent * local): " + transformSummary(childAccumulatedLocation));
    logLine("  - sourceShape.Location(): " + transformSummary(sourceShape.Location()));
    logLine("  - renderShape.Location(): " + transformSummary(renderShape.Location()));
    logLine("  - transform mode: " + std::string(cliOptions.debugLegacyTransform ? "legacy (incorrect)" : "fixed (correct)"));
    logLine("  - final GLB/node transform contract: identity (vertices baked in world coordinates)");
  }

  const std::string localTransform = transformSummary(localLocation);
  const std::string accumulatedTransform = transformSummary(renderShape.Location());

  const std::string labelPath = labelEntry(label);
  const std::string effectiveInstancePath = instancePath.empty() ? labelPath : instancePath;
  const std::string referredPath = referred.IsNull() ? "" : labelEntry(referred);
  const std::string objectName = readableLabelName(label);
  const std::string referredName = readableLabelName(referred);
  const std::string parentLabelPath = label.Father().IsNull() ? "" : labelEntry(label.Father());
  const auto instanceLayers = collectLayerInfos(layerTool, label);
  const auto referredLayers = referred.IsNull() ? std::vector<LayerInfo>() : collectLayerInfos(layerTool, referred);
  const auto layers = mergeLayers(mergeLayers(instanceLayers, referredLayers), inheritedLayers);
  const std::string layer = firstLayerName(layers);
  const std::string resolvedObjectName = safeName(
      objectName,
      safeName(parentProductName,
          safeName(referredName, safeName(parentDisplayName, safeName(layer, "Unnamed object")))));
  const std::string displayName = resolvedObjectName;
  const std::vector<std::string> nameCandidates = {
      objectName, referredName, parentDisplayName, parentProductName, layer,
      labelName(label), referred.IsNull() ? "" : labelName(referred)};
  const std::vector<std::string> rawStyleNames = {
      displayName, referredName, objectName, labelName(label), referredPath, labelPath};
  if (displayName != "Unnamed object") {
    stats.namedObjects += 1;
  }
  if (!layer.empty()) {
    stats.layers.insert(layer);
  }

  Colour labelColour;
  bool labelHasColour = findLabelColour(colourTool, label, labelColour);
  Colour owningShapeColour;
  const bool owningShapeHasColour = firstColourForShape(colourTool, sourceShape, "owning_shape_", "label", labelPath, owningShapeColour);

  Colour referredColour;
  const bool referredHasColour = referredLabelColour(colourTool, referred, referredColour);
  RawStepStyleMatch rawStepMatch;
  RawStepStyleMatch rawStepRejectedMatch;
  Colour rawStepColour;
  const bool rawStepHasColour = !cliOptions.debugSkipRawStepStyles && rawStepStyles != nullptr &&
      rawStepStyles->findForNames(
          rawStyleNames,
          rawStepMatch,
          rawStepRejectedMatch);
  if (rawStepHasColour) {
    rawStepColour = rawStepMatch.colour;
    if (cliOptions.colourMode.mode == ColourMode::StepPresentation) {
      rawStepColour = linearizedStepPresentationColour(rawStepColour);
      rawStepColour.source = "step_presentation_styled_item";
      rawStepColour.materialSource = "step_presentation_styled_item";
    }
    rawStepColour.lookupPath = rawStepMatch.path;
    rawStepColour.fallbackReason = "confidence=" + rawStepMatch.confidence +
        " styledItem=" + rawStepMatch.styledItemId +
        " target=" + rawStepMatch.styledTargetId +
        " targetType=" + rawStepMatch.styledTargetType +
        " targetScope=" + rawStepMatch.styledTargetScope;
  }
  const auto styledTopologyColours = cliOptions.debugSkipRawStepStyles ? std::vector<StyledTopologyColour>() : mapStepPresentationToSubshapes(
      rawStepStyles,
      cliOptions.colourMode,
      sourceShape,
      rawStyleNames,
      rawStepRejectedMatch);
  if (!styledTopologyColours.empty()) {
    rawStepRejectedMatch.rejectedReason.clear();
  }
  if (!rawStepHasColour && !rawStepRejectedMatch.rejectedReason.empty()) {
    if (rawStepRejectedMatch.rejectedReason.find("ambiguous") != std::string::npos ||
        rawStepRejectedMatch.rejectedReason.find("multiple STEP representation groups") != std::string::npos) {
      stats.rawStepAmbiguousRepresentationRejects += 1;
    } else {
      stats.rawStepBroadRepresentationRejects += 1;
    }
  }

  std::vector<SubshapeColourCandidate> subshapeColours;
  collectColouredSubshapes(shapeTool, colourTool, layerTool, label, "subshape", subshapeColours);
  if (!referred.IsNull()) {
    collectColouredSubshapes(shapeTool, colourTool, layerTool, referred, "referred_subshape", subshapeColours);
  }
  if (rawStepStyles != nullptr) {
    rawStepStyles->applyExactLayerTargetNames(subshapeColours);
  }
  for (const auto& candidate : subshapeColours) {
    if (candidate.hasLayerColour) {
      stats.subshapeLayerColourCandidates += 1;
    }
  }

  if (labelHasColour || owningShapeHasColour || referredHasColour || !subshapeColours.empty()) {
    stats.labelsWithColour += 1;
  }

  Colour ancestorCandidate;
  const bool ancestorHasCandidateColour = nearestAncestorColour(hasInheritedColour, inheritedColour, ancestorCandidate);
  Colour layerCandidate;
  const bool layerHasCandidateColour = layerColour(colourTool, layers, layerCandidate);
  if (layerHasCandidateColour) {
    stats.labelsWithLayerColourCandidates += 1;
  }
  std::string baseCandidateColours;
  baseCandidateColours = appendCandidateSummary(baseCandidateColours, "instanceLabel", labelHasColour, labelColour);
  baseCandidateColours = appendCandidateSummary(baseCandidateColours, "owningShape", owningShapeHasColour, owningShapeColour);
  baseCandidateColours = appendCandidateSummary(baseCandidateColours, "referredLabel", referredHasColour, referredColour);
  baseCandidateColours = appendCandidateSummary(baseCandidateColours, "rawStepStyledItem", rawStepHasColour, rawStepColour);
  if (!rawStepRejectedMatch.rejectedReason.empty()) {
    baseCandidateColours = baseCandidateColours.empty()
        ? "rawStepRejected=" + rawStepRejectedMatch.rejectedReason
        : baseCandidateColours + "; rawStepRejected=" + rawStepRejectedMatch.rejectedReason;
  }
  baseCandidateColours = appendCandidateSummary(baseCandidateColours, "ancestor", ancestorHasCandidateColour, ancestorCandidate);
  baseCandidateColours = appendCandidateSummary(baseCandidateColours, "labelOrAncestorLayer", layerHasCandidateColour, layerCandidate);

  // Build caches for O(1) shape lookups
  std::unordered_map<TopoDS_TShape*, size_t> styledFaceCache;
  std::unordered_map<TopoDS_TShape*, size_t> subshapeFaceCache;

  if (!cliOptions.debugDisableStyleCache) {
    // 1. Build styledFaceCache
    for (size_t idx = 0; idx < styledTopologyColours.size(); ++idx) {
      const auto& candidate = styledTopologyColours[idx];
      if (candidate.shape.IsNull()) continue;
      
      auto bindTShape = [&](const TopoDS_Shape& s) {
        if (!s.IsNull() && s.TShape()) {
          auto* ptr = s.TShape().get();
          if (styledFaceCache.find(ptr) == styledFaceCache.end()) {
            styledFaceCache[ptr] = idx;
          }
        }
      };

      if (candidate.shape.ShapeType() == TopAbs_FACE) {
        bindTShape(candidate.shape);
      } else {
        for (TopExp_Explorer exp(candidate.shape, TopAbs_FACE); exp.More(); exp.Next()) {
          bindTShape(exp.Current());
        }
      }
    }

    // 2. Build subshapeFaceCache
    for (size_t idx = 0; idx < subshapeColours.size(); ++idx) {
      const auto& candidate = subshapeColours[idx];
      if (candidate.shape.IsNull()) continue;

      auto bindTShape = [&](const TopoDS_Shape& s) {
        if (!s.IsNull() && s.TShape()) {
          auto* ptr = s.TShape().get();
          if (subshapeFaceCache.find(ptr) == subshapeFaceCache.end()) {
            subshapeFaceCache[ptr] = idx;
          }
        }
      };

      if (candidate.shape.ShapeType() == TopAbs_FACE) {
        bindTShape(candidate.shape);
      } else {
        for (TopExp_Explorer exp(candidate.shape, TopAbs_FACE); exp.More(); exp.Next()) {
          bindTShape(exp.Current());
        }
      }
    }
  }

  bool isMirrored = childAccumulatedLocation.Transformation().IsNegative();
  bool faceStyle = (!styledTopologyColours.empty() || !subshapeColours.empty());
  bool reuseSafe = cliOptions.enableMeshReuse && !isMirrored && !faceStyle;
  void* tshapePtr = sourceShape.TShape().get();

  double linDeflect = quality.linearDeflection;
  double angDeflect = quality.angularDeflection;
  bool relDeflect = quality.relative;
  if (cliOptions.debugSuperCoarseMesh) {
    linDeflect = 5.0;
    angDeflect = 1.5;
    relDeflect = true;
  }

  Colour shapeColour;
  if (labelHasColour) {
    shapeColour = labelColour;
  } else if (owningShapeHasColour) {
    shapeColour = owningShapeColour;
  } else if (referredHasColour) {
    shapeColour = referredColour;
  } else if (rawStepHasColour && cliOptions.colourMode.applyRawStepStyles) {
    shapeColour = rawStepColour;
  } else if (ancestorHasCandidateColour) {
    shapeColour = ancestorCandidate;
  } else if (layerHasCandidateColour && cliOptions.colourMode.applyLayerColours) {
    shapeColour = layerCandidate;
  } else {
    shapeColour = defaultColour(
        cliOptions.colourMode.mode == ColourMode::XcafBaseline
            ? "no direct XCAF face/subshape, owning label/body, referred/original label, instance/component label, or explicit inherited ancestor colour found; raw STEP styles and layer colours are diagnostic-only in xcaf-baseline"
            : "no face/subshape, label, referred-label, ancestor, or layer colour found",
        labelPath);
  }

  std::string materialSignature = "face-styled";
  if (!faceStyle) {
    materialSignature = "color:" + colourKey(shapeColour);
  }

  ReuseKey key;
  key.tshapePtr = tshapePtr;
  key.linearDeflection = linDeflect;
  key.angularDeflection = angDeflect;
  key.relative = relDeflect;
  key.materialSignature = materialSignature;
  key.isSafe = reuseSafe;

  bool hasCached = false;
  if (reuseSafe) {
    if (reuseCache.find(key) != reuseCache.end()) {
      hasCached = true;
      stats.tessellationCacheHits++;
    } else {
      stats.tessellationCacheMisses++;
      
      const auto meshStarted = std::chrono::steady_clock::now();
      TopoDS_Shape localShape = sourceShape;
      localShape.Location(TopLoc_Location());

      try {
        BRepMesh_IncrementalMesh mesh(localShape, linDeflect, relDeflect, angDeflect, cliOptions.parallelMesh ? Standard_True : Standard_False);
        mesh.Perform();
        
        CachedGeometry cached;
        MeshPrimitive localPrim;
        
        TopExp_Explorer localExplorer(localShape, TopAbs_FACE);
        for (; localExplorer.More(); localExplorer.Next()) {
          const TopoDS_Face localFace = TopoDS::Face(localExplorer.Current());
          appendFaceTriangles(localPrim, localFace);
          cached.faceCount++;
        }
        
        cached.positions = localPrim.positions;
        cached.normals = localPrim.normals;
        cached.indices = localPrim.indices;
        cached.min = localPrim.min;
        cached.max = localPrim.max;
        
        reuseCache[key] = cached;
        hasCached = true;
        stats.shapesTessellated++;
        stats.uniqueStoredTriangles += cached.indices.size() / 3;
        
        const auto meshFinished = std::chrono::steady_clock::now();
        double ms = std::chrono::duration<double, std::milli>(meshFinished - meshStarted).count();
        logLine("[Mesh Cache Build] Meshed shape in local coordinates: elapsedMs=" + std::to_string(ms));
      } catch (const Standard_Failure& failure) {
        logLine("[Mesh Cache Build] Local tessellation failed for " + labelPath + ": " + failure.GetMessageString());
        stats.failedShapes++;
        reuseSafe = false;
      }
    }
  }

  if (!reuseSafe) {
    meshedCount++;
    logLine("Meshing shape " + std::to_string(meshedCount) + " / " + std::to_string(totalShapesToMesh) +
            ": name=" + displayName + " path=" + labelPath +
            " linearDeflection=" + std::to_string(linDeflect) +
            " angularDeflection=" + std::to_string(angDeflect) +
            " relative=" + (relDeflect ? "true" : "false") +
            " parallel=" + (cliOptions.parallelMesh ? "true" : "false"));

    try {
      const auto meshStarted = std::chrono::steady_clock::now();
      BRepMesh_IncrementalMesh mesh(renderShape, linDeflect, relDeflect, angDeflect, cliOptions.parallelMesh ? Standard_True : Standard_False);
      mesh.Perform();
      const auto meshFinished = std::chrono::steady_clock::now();
      double ms = std::chrono::duration<double, std::milli>(meshFinished - meshStarted).count();
      
      logLine("Meshed shape " + std::to_string(meshedCount) + " / " + std::to_string(totalShapesToMesh) +
              ": elapsedMs=" + std::to_string(ms));
      stats.shapesTessellated += 1;
    } catch (const Standard_Failure& failure) {
      logLine("Tessellation failed for " + labelPath + ": " + failure.GetMessageString());
      stats.failedShapes += 1;
      return;
    }
  }

  int faceIndex = 0;
  std::map<ExportObjectKey, std::size_t> primitiveByKey;
  std::vector<std::size_t> createdPrimitiveIndices;
  TopExp_Explorer sourceExplorer(sourceShape, TopAbs_FACE);
  TopExp_Explorer renderExplorer(renderShape, TopAbs_FACE);
  for (; renderExplorer.More(); renderExplorer.Next()) {
    const TopoDS_Face renderFace = TopoDS::Face(renderExplorer.Current());
    TopoDS_Face sourceFace = renderFace;
    if (sourceExplorer.More()) {
      sourceFace = TopoDS::Face(sourceExplorer.Current());
      sourceExplorer.Next();
    }
    TopLoc_Location loc;
    if (BRep_Tool::Triangulation(renderFace, loc).IsNull()) {
      continue;
    }

    Colour colour = labelColour;
    bool hasColour = labelHasColour;
    bool faceOrSubshapeHasColour = false;
    std::string primitiveLayer = layer;
    Colour faceColour;
    std::vector<LayerInfo> matchedSubshapeLayers;
    bool matchedSubshapeHasColour = false;
    bool matchedSubshapeHasLayerColour = false;
    Colour matchedSubshapeLayerColour;
    std::string matchedSubshapeLabelPath;
    std::string matchedSubshapeName;
    std::string matchedSubshapeNameSource;
    RawStepStyleMatch faceStepPresentationMatch;
    std::string faceGeometrySource = "simple shape";
    const bool faceHasStepPresentationColour = !cliOptions.debugSkipRawStepStyles &&
        stepPresentationColourForFace(sourceFace, styledTopologyColours, styledFaceCache, !cliOptions.debugDisableStyleCache, faceStepPresentationMatch, faceGeometrySource);
    if (firstColourForShape(colourTool, sourceFace, "face_", "face/subshape", labelPath + "/face/" + std::to_string(faceIndex), faceColour)) {
      colour = faceColour;
      hasColour = true;
      faceOrSubshapeHasColour = true;
    } else if (matchingSubshapeColour(
                   sourceFace,
                   subshapeColours,
                   subshapeFaceCache,
                   !cliOptions.debugDisableStyleCache,
                   faceColour,
                   matchedSubshapeLayers,
                   matchedSubshapeHasColour,
                   matchedSubshapeHasLayerColour,
                   matchedSubshapeLayerColour,
                   matchedSubshapeLabelPath,
                   matchedSubshapeName,
                   matchedSubshapeNameSource) &&
               matchedSubshapeHasColour) {
      colour = faceColour;
      hasColour = true;
      faceOrSubshapeHasColour = true;
      primitiveLayer = firstLayerName(matchedSubshapeLayers).empty() ? primitiveLayer : firstLayerName(matchedSubshapeLayers);
    } else if (owningShapeHasColour) {
      colour = owningShapeColour;
      hasColour = true;
    } else if (!labelHasColour && referredHasColour) {
      colour = referredColour;
      hasColour = true;
    } else if (!labelHasColour && faceHasStepPresentationColour && cliOptions.colourMode.mode == ColourMode::StepPresentation) {
      colour = faceStepPresentationMatch.colour;
      hasColour = true;
      stats.rawStepColourUses += 1;
      stats.rawStepMappingConfidenceCounts[faceStepPresentationMatch.confidence] += 1;
    } else if (!labelHasColour && rawStepHasColour && cliOptions.colourMode.applyRawStepStyles) {
      colour = rawStepColour;
      hasColour = true;
      stats.rawStepColourUses += 1;
      stats.rawStepMappingConfidenceCounts[rawStepMatch.confidence] += 1;
    } else if (!labelHasColour && ancestorHasCandidateColour) {
      colour = ancestorCandidate;
      hasColour = true;
    } else if (!labelHasColour && matchedSubshapeHasLayerColour && cliOptions.colourMode.applyLayerColours) {
      colour = matchedSubshapeLayerColour;
      colour.source = "subshape_layer_" + colour.source;
      colour.materialSource = "layer";
      hasColour = true;
      primitiveLayer = firstLayerName(matchedSubshapeLayers).empty() ? primitiveLayer : firstLayerName(matchedSubshapeLayers);
    } else if (!labelHasColour && layerHasCandidateColour && cliOptions.colourMode.applyLayerColours) {
      colour = layerCandidate;
      hasColour = true;
    }

    if (!hasColour) {
      stats.defaultMaterialUses += 1;
      fallbackColorsCount++;
      colour = defaultColour(
          cliOptions.colourMode.mode == ColourMode::XcafBaseline
              ? "no direct XCAF face/subshape, owning label/body, referred/original label, instance/component label, or explicit inherited ancestor colour found; raw STEP styles and layer colours are diagnostic-only in xcaf-baseline"
              : "no face/subshape, label, referred-label, ancestor, or layer colour found",
          labelPath + "/face/" + std::to_string(faceIndex));
    } else {
      styledFacesCount++;
    }
    if (!primitiveLayer.empty()) {
      stats.layers.insert(primitiveLayer);
    }
    const std::string stepObjectName =
        faceHasStepPresentationColour && !isRawLabelName(faceStepPresentationMatch.styledTargetName)
            ? faceStepPresentationMatch.styledTargetName
            : "";
    const std::string faceResolvedObjectName = safeName(
        objectName,
        safeName(parentProductName,
            safeName(referredName,
                safeName(parentDisplayName,
                    safeName(stepObjectName, safeName(matchedSubshapeName, safeName(primitiveLayer, "Unnamed object")))))));
    const std::string faceNameSource =
        !objectName.empty() ? "xcaf-label" :
        (!parentProductName.empty() ? "product" :
         (!referredName.empty() ? "xcaf-referred-label" :
           (!parentDisplayName.empty() ? "parent" :
            (!stepObjectName.empty() ? "step-manifold-solid-brep" :
             (!matchedSubshapeName.empty() ? matchedSubshapeNameSource :
              (!primitiveLayer.empty() ? "layer" : "unnamed"))))));
    const std::vector<std::string> faceNameCandidates = {
        objectName, referredName, parentDisplayName, parentProductName, stepObjectName, matchedSubshapeName,
        faceStepPresentationMatch.representationName, primitiveLayer,
        labelName(label), referred.IsNull() ? "" : labelName(referred)};
    const std::string topologyKey =
        faceHasStepPresentationColour
            ? faceStepPresentationMatch.styledTargetId
            : ((!matchedSubshapeName.empty() || faceNameSource == "layer") ? matchedSubshapeLabelPath : "");
    const std::string selectableId = effectiveInstancePath +
        (topologyKey.empty() ? "" : "/subshape/" + topologyKey);
    const std::string stableTopologySuffix =
        faceHasStepPresentationColour ? "/step-target/" + faceStepPresentationMatch.styledTargetId : "";

    const ExportObjectKey key = {
        labelPath,
        faceResolvedObjectName,
        primitiveLayer,
        colourKey(colour),
        colour.materialSource,
        colour.source,
        topologyKey};
    auto found = primitiveByKey.find(key);
    if (found == primitiveByKey.end()) {
      MeshPrimitive primitive;
      primitive.name = faceResolvedObjectName + " " + colour.source;
      primitive.labelPath = labelPath;
      primitive.instancePath = selectableId;
      primitive.displayName = faceResolvedObjectName;
      primitive.resolvedObjectName = faceResolvedObjectName;
      primitive.objectName = objectName;
      primitive.partName = safeName(stepObjectName, matchedSubshapeName);
      primitive.blockName = parentDisplayName;
      primitive.componentName = safeName(parentProductName, referredName);
      primitive.productName = parentProductName;
      primitive.representationName = faceStepPresentationMatch.representationName;
      primitive.nameSource = faceNameSource;
      primitive.nameCandidates = faceNameCandidates;
      primitive.layer = primitiveLayer;
      primitive.colourSource = colour.source;
      primitive.materialSource = colour.materialSource;
      primitive.colourLookupPath = colour.lookupPath;
      primitive.colourType = colour.colourType;
      primitive.fallbackReason = colour.fallbackReason;
      primitive.originalStepLabel = referredPath.empty() ? labelPath : referredPath;
      primitive.originalStepName = safeName(stepObjectName, safeName(matchedSubshapeName, safeName(referredName, faceResolvedObjectName)));
      primitive.parentLabelPath = parentLabelPath;
      primitive.shapeType = shapeTypeName(sourceShape.ShapeType());
      primitive.transformSource = transformSource;
      primitive.localTransform = localTransform;
      primitive.accumulatedTransform = accumulatedTransform;
      primitive.exactColourLookupPath = colour.lookupPath;
      primitive.labelRole =
          shapeTool->IsReference(label) ? "reference/component" :
          (shapeTool->IsAssembly(label) ? "assembly" :
           (shapeTool->IsSimpleShape(label) ? "simple/original" : "shape"));
      primitive.parentChain = appendChain(parentChain, labelPath);
      primitive.instanceLabelLayers = layerNames(instanceLayers);
      primitive.referredLabelLayers = layerNames(referredLayers);
      primitive.ancestorLayers = layerNames(inheritedLayers);
      primitive.matchedSubshapeLayers = layerNames(matchedSubshapeLayers);
      primitive.matchedSubshapeLabelPath = matchedSubshapeLabelPath;
      primitive.matchedSubshapeName = matchedSubshapeName;
      primitive.matchedSubshapeNameSource = matchedSubshapeNameSource;
      primitive.candidateColours = appendCandidateSummary(
          baseCandidateColours,
          "matchedSubshapeLayer",
          matchedSubshapeHasLayerColour,
          matchedSubshapeLayerColour);
      primitive.candidateColours = appendCandidateSummary(
          primitive.candidateColours,
          "faceOrMatchedSubshape",
          faceOrSubshapeHasColour,
          faceColour);
      primitive.colourTrace = colourTraceSummary(
          faceOrSubshapeHasColour,
          colour,
          labelHasColour,
          labelColour,
          owningShapeHasColour,
          owningShapeColour,
          referredHasColour,
          referredColour,
          ancestorHasCandidateColour,
          ancestorCandidate,
          layerHasCandidateColour,
          layerCandidate,
          rawStepHasColour,
          rawStepColour,
          static_cast<int>(subshapeColours.size()));
      primitive.instanceLabelColour = colourSummary(labelHasColour, labelColour);
      primitive.referredLabelColour = colourSummary(referredHasColour, referredColour);
      primitive.owningShapeColour = colourSummary(owningShapeHasColour, owningShapeColour);
      primitive.ancestorColour = colourSummary(ancestorHasCandidateColour, ancestorCandidate);
      primitive.layerColour = colourSummary(layerHasCandidateColour, layerCandidate);
      primitive.rawStepMappingConfidence = rawStepHasColour ? rawStepMatch.confidence : "";
      primitive.rawStepStyledItemId = rawStepHasColour ? rawStepMatch.styledItemId : "";
      primitive.rawStepTargetId = rawStepHasColour ? rawStepMatch.styledTargetId : "";
      primitive.rawStepTargetType = rawStepHasColour ? rawStepMatch.styledTargetType : "";
      primitive.rawStepTargetScope = rawStepHasColour ? rawStepMatch.styledTargetScope : "";
      primitive.rawStepTargetPath = rawStepHasColour ? rawStepMatch.path : "";
      if (faceHasStepPresentationColour) {
        primitive.rawStepMappingConfidence = faceStepPresentationMatch.confidence;
        primitive.rawStepStyledItemId = faceStepPresentationMatch.styledItemId;
        primitive.rawStepTargetId = faceStepPresentationMatch.styledTargetId;
        primitive.rawStepTargetType = faceStepPresentationMatch.styledTargetType;
        primitive.rawStepTargetScope = faceStepPresentationMatch.styledTargetScope;
        primitive.rawStepTargetPath = faceStepPresentationMatch.path;
      }
      primitive.rawStepRejectedReason =
          (rawStepHasColour || faceHasStepPresentationColour)
              ? ""
              : rawStepRejectedMatch.rejectedReason;
      primitive.geometrySource = faceGeometrySource;
      primitive.subshapeColourCandidates = static_cast<int>(subshapeColours.size());
      primitive.ancestorHasColour = hasInheritedColour;
      primitive.faceOrSubshapeHasColour = faceOrSubshapeHasColour;
      primitive.stableObjectId = selectableId + "/material/" + colourKey(colour) +
          stableTopologySuffix;
      primitive.colour = colour;
      primitives.push_back(std::move(primitive));
      const std::size_t index = primitives.size() - 1;
      primitiveByKey[key] = index;
      createdPrimitiveIndices.push_back(index);
      found = primitiveByKey.find(key);
    }

    MeshPrimitive& primitive = primitives[found->second];
    if (reuseSafe) {
      primitive.faceCount += 1;
      primitive.faceOrSubshapeHasColour = primitive.faceOrSubshapeHasColour || faceOrSubshapeHasColour;
    } else {
      const std::size_t verticesBefore = primitive.positions.size() / 3;
      appendFaceTriangles(primitive, renderFace);
      if (primitive.positions.size() / 3 > verticesBefore) {
        primitive.faceCount += 1;
        primitive.faceOrSubshapeHasColour = primitive.faceOrSubshapeHasColour || faceOrSubshapeHasColour;
      }
    }
    faceIndex += 1;
  }

  for (const std::size_t index : createdPrimitiveIndices) {
    auto& primitive = primitives[index];
    if (reuseSafe) {
      primitive.isReused = true;
      primitive.tshapePtr = tshapePtr;
      primitive.reuseKey = key;
      primitive.transform = childAccumulatedLocation.Transformation();
      const auto& cached = reuseCache[key];
      primitive.positions = cached.positions;
      primitive.normals = cached.normals;
      primitive.indices = cached.indices;
      primitive.min = cached.min;
      primitive.max = cached.max;
      primitive.faceCount = cached.faceCount;
      computeWorldBounds(primitive.min, primitive.max, primitive.transform, primitive.worldMin, primitive.worldMax);

      // Perform transform audit for the first 50 instances
      static int auditInstancesCount = 0;
      if (auditInstancesCount < 50) {
        auditInstancesCount++;
        validateWorldBounds(primitive, renderShape, effectiveInstancePath);
        
        std::array<float, 3> reusedWorldMin = {std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};

        std::array<float, 3> reusedWorldMax = {std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
        for (std::size_t vi = 0; vi < cached.positions.size(); vi += 3) {
          gp_Pnt p(cached.positions[vi], cached.positions[vi+1], cached.positions[vi+2]);
          p.Transform(primitive.transform);
          reusedWorldMin[0] = std::min(reusedWorldMin[0], (float)p.X());
          reusedWorldMin[1] = std::min(reusedWorldMin[1], (float)p.Y());
          reusedWorldMin[2] = std::min(reusedWorldMin[2], (float)p.Z());
          reusedWorldMax[0] = std::max(reusedWorldMax[0], (float)p.X());
          reusedWorldMax[1] = std::max(reusedWorldMax[1], (float)p.Y());
          reusedWorldMax[2] = std::max(reusedWorldMax[2], (float)p.Z());
        }

        BRepMesh_IncrementalMesh worldMesh(renderShape, linDeflect, relDeflect, angDeflect, cliOptions.parallelMesh ? Standard_True : Standard_False);
        worldMesh.Perform();
        std::array<float, 3> bakedWorldMin = {std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
        std::array<float, 3> bakedWorldMax = {std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
        TopExp_Explorer renderExplorer(renderShape, TopAbs_FACE);
        for (; renderExplorer.More(); renderExplorer.Next()) {
          const TopoDS_Face renderFace = TopoDS::Face(renderExplorer.Current());
          TopLoc_Location loc;
          Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(renderFace, loc);
          if (!tri.IsNull()) {
            const gp_Trsf t = loc.Transformation();
            for (Standard_Integer nodeIdx = 1; nodeIdx <= tri->NbNodes(); ++nodeIdx) {
              gp_Pnt p = tri->Node(nodeIdx);
              p.Transform(t);
              bakedWorldMin[0] = std::min(bakedWorldMin[0], (float)p.X());
              bakedWorldMin[1] = std::min(bakedWorldMin[1], (float)p.Y());
              bakedWorldMin[2] = std::min(bakedWorldMin[2], (float)p.Z());
              bakedWorldMax[0] = std::max(bakedWorldMax[0], (float)p.X());
              bakedWorldMax[1] = std::max(bakedWorldMax[1], (float)p.Y());
              bakedWorldMax[2] = std::max(bakedWorldMax[2], (float)p.Z());
            }
          }
        }

        double diffMin = std::sqrt(std::pow(reusedWorldMin[0] - bakedWorldMin[0], 2) +
                                   std::pow(reusedWorldMin[1] - bakedWorldMin[1], 2) +
                                   std::pow(reusedWorldMin[2] - bakedWorldMin[2], 2));
        double diffMax = std::sqrt(std::pow(reusedWorldMax[0] - bakedWorldMax[0], 2) +
                                   std::pow(reusedWorldMax[1] - bakedWorldMax[1], 2) +
                                   std::pow(reusedWorldMax[2] - bakedWorldMax[2], 2));

        logLine("[TRANSFORM_AUDIT #" + std::to_string(auditInstancesCount) + "] Reused vs Baked Bbox comparison for " + effectiveInstancePath + ":");
        logLine("  - Reused Bbox: [" + std::to_string(reusedWorldMin[0]) + "," + std::to_string(reusedWorldMin[1]) + "," + std::to_string(reusedWorldMin[2]) + "] to [" + std::to_string(reusedWorldMax[0]) + "," + std::to_string(reusedWorldMax[1]) + "," + std::to_string(reusedWorldMax[2]) + "]");
        logLine("  - Baked Bbox:  [" + std::to_string(bakedWorldMin[0]) + "," + std::to_string(bakedWorldMin[1]) + "," + std::to_string(bakedWorldMin[2]) + "] to [" + std::to_string(bakedWorldMax[0]) + "," + std::to_string(bakedWorldMax[1]) + "," + std::to_string(bakedWorldMax[2]) + "]");
        logLine("  - DiffMin: " + std::to_string(diffMin) + ", DiffMax: " + std::to_string(diffMax));

        if (diffMin > 1e-2 || diffMax > 1e-2) {
          logLine("[WARNING] Bbox discrepancy between reused instance and baked instance is large!");
        }
      }

      stats.vertices += cached.positions.size() / 3;
      stats.triangles += cached.indices.size() / 3;
      stats.reusedInstances++;
    } else {
      primitive.isReused = false;
      primitive.worldMin = primitive.min;
      primitive.worldMax = primitive.max;

      if (primitive.indices.empty()) {
        continue;
      }
      stats.vertices += primitive.positions.size() / 3;
      stats.triangles += primitive.indices.size() / 3;
      stats.uniqueStoredTriangles += primitive.indices.size() / 3;
      stats.freshInstances++;
    }
    stats.primitivesExported += 1;
    stats.coloursBySource[primitive.colourSource] += 1;
    stats.materialSourceCounts[primitive.materialSource] += 1;
    stats.uniqueColours.insert(colourKey(primitive.colour));
  }
}

void traverse(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const RawStepStyleResolver* rawStepStyles,
    const CliOptions& cliOptions,
    const TDF_Label& label,
    const Quality& quality,
    const std::string& instancePath,
    const TopLoc_Location& accumulatedLocation,
    const std::string& transformSource,
    const bool hasInheritedColour,
    const Colour& inheritedColour,
    const std::vector<LayerInfo>& inheritedLayers,
    const std::string& parentChain,
    const std::string& parentDisplayName,
    const std::string& parentProductName,
    std::vector<MeshPrimitive>& primitives,
    Stats& stats) {
  TDF_LabelSequence children;
  const std::string labelPath = labelEntry(label);
  const std::string currentInstancePath = appendInstancePath(instancePath, labelPath);
  TDF_Label currentReferred;
  if (shapeTool->IsReference(label)) {
    shapeTool->GetReferredShape(label, currentReferred);
  }
  const auto currentLayers = collectLabelAndReferredLayers(layerTool, label, currentReferred);
  const auto childInheritedLayers = mergeLayers(inheritedLayers, currentLayers);
  const std::string currentParentChain = appendChain(parentChain, labelPath);
  bool hasChildren = shapeTool->GetComponents(label, children, Standard_False);
  TopLoc_Location childAccumulatedLocation = accumulatedLocation;
  std::string childTransformSource = transformSource;
  if (!hasChildren && shapeTool->IsReference(label)) {
    TDF_Label referred;
    if (shapeTool->GetReferredShape(label, referred)) {
      hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
      const TopLoc_Location referenceLocation = shapeLocation(shapeTool, label);
      childAccumulatedLocation = accumulatedLocation * referenceLocation;
      childTransformSource = "referred_assembly_instance";
    }
  }
  const std::string rawProductName = rawStepStyles == nullptr ? "" : rawStepStyles->uniqueProductName();
  const std::string currentProductName = safeName(parentProductName, hasChildren ? rawProductName : "");
  const std::string currentDisplayName = safeName(
      readableLabelName(label),
      safeName(currentProductName, safeName(readableLabelName(currentReferred), parentDisplayName)));

  if (hasChildren && children.Length() > 0) {
    stats.labelsProcessed += 1;
    const std::string name = labelName(label);
    if (!name.empty()) {
      stats.namedObjects += 1;
    }
    Colour childInherited = inheritedColour;
    bool childHasInherited = hasInheritedColour;
    if (firstColourForLabel(colourTool, label, "label_", "ancestor", childInherited)) {
      childHasInherited = true;
      stats.labelsWithColour += 1;
    } else if (shapeTool->IsReference(label)) {
      TDF_Label referred;
      if (shapeTool->GetReferredShape(label, referred) &&
          firstColourForLabel(colourTool, referred, "referred_label_", "ancestor", childInherited)) {
        childHasInherited = true;
        stats.labelsWithColour += 1;
      }
    }
    for (Standard_Integer i = 1; i <= children.Length(); ++i) {
      traverse(
          shapeTool,
          colourTool,
          layerTool,
          rawStepStyles,
          cliOptions,
          children.Value(i),
          quality,
          currentInstancePath,
          childAccumulatedLocation,
          childTransformSource,
          childHasInherited,
          childInherited,
          childInheritedLayers,
          currentParentChain,
          currentDisplayName,
          currentProductName,
          primitives,
          stats);
    }
    return;
  }

  tessellateLabel(
      shapeTool,
      colourTool,
      layerTool,
      rawStepStyles,
      cliOptions,
      label,
      quality,
      currentInstancePath,
      accumulatedLocation,
      transformSource,
      hasInheritedColour,
      inheritedColour,
      inheritedLayers,
      parentChain,
      parentDisplayName,
      parentProductName,
      primitives,
      stats);
}

template <typename T>
void appendScalar(std::vector<std::uint8_t>& data, const T& value) {
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(&value);
  data.insert(data.end(), bytes, bytes + sizeof(T));
}

void alignBuffer(std::vector<std::uint8_t>& data, std::uint8_t pad = 0) {
  while (data.size() % 4 != 0) {
    data.push_back(pad);
  }
}

struct BufferViewInfo {
  std::size_t offset = 0;
  std::size_t length = 0;
  int target = 0;
};

struct AccessorInfo {
  int bufferView = 0;
  int componentType = 0;
  std::size_t count = 0;
  std::string type;
  std::array<float, 3> min = {0, 0, 0};
  std::array<float, 3> max = {0, 0, 0};
  bool hasMinMax = false;
};

int addFloatBuffer(
    std::vector<std::uint8_t>& bin,
    std::vector<BufferViewInfo>& views,
    const std::vector<float>& values,
    const int target) {
  alignBuffer(bin);
  BufferViewInfo view;
  view.offset = bin.size();
  view.length = values.size() * sizeof(float);
  view.target = target;
  for (const float value : values) {
    appendScalar(bin, value);
  }
  views.push_back(view);
  return static_cast<int>(views.size() - 1);
}

int addIndexBuffer(
    std::vector<std::uint8_t>& bin,
    std::vector<BufferViewInfo>& views,
    const std::vector<std::uint32_t>& values) {
  alignBuffer(bin);
  BufferViewInfo view;
  view.offset = bin.size();
  view.length = values.size() * sizeof(std::uint32_t);
  view.target = 34963;
  for (const auto value : values) {
    appendScalar(bin, value);
  }
  views.push_back(view);
  return static_cast<int>(views.size() - 1);
}

void writeGlb(
    const std::filesystem::path& outputPath,
    const std::vector<MeshPrimitive>& primitives,
    const ColourSpaceConfig& colourSpace,
    Profiler* profiler = nullptr) {
  if (profiler) profiler->startStage("GLB primitive generation");
  std::vector<std::uint8_t> bin;
  std::vector<BufferViewInfo> views;
  std::vector<AccessorInfo> accessors;

  struct MeshRefs {
    int positionAccessor = -1;
    int normalAccessor = -1;
    int indexAccessor = -1;
    int material = -1;
  };

  std::map<std::string, int> materialByColour;
  std::vector<Colour> materials;

  // Resolve materials first
  for (const auto& primitive : primitives) {
    const Colour glbColour = convertColourForGlb(primitive.colour, colourSpace);
    const std::string key = colourKey(glbColour);
    if (materialByColour.find(key) == materialByColour.end()) {
      int materialIndex = static_cast<int>(materials.size());
      materialByColour[key] = materialIndex;
      materials.push_back(glbColour);
    }
  }

  // Group reused primitives by their ReuseKey (or rather, the mesh signature ReuseKey + glbColour)
  // to share accessors and mesh indices.
  struct SharedMeshKey {
    ReuseKey reuseKey;
    std::string materialKey;

    bool operator<(const SharedMeshKey& o) const {
      if (reuseKey < o.reuseKey) return true;
      if (o.reuseKey < reuseKey) return false;
      return materialKey < o.materialKey;
    }
  };

  std::map<SharedMeshKey, int> sharedMeshIndexByKey;
  std::map<SharedMeshKey, MeshRefs> sharedMeshRefsByKey;

  // We will have a list of meshes in the glTF "meshes" array
  struct GlbMesh {
    std::string name;
    MeshRefs refs;
    std::string selectableId;
    std::string displayName;
    std::string resolvedObjectName;
    std::string objectName;
    std::string partName;
    std::string blockName;
    std::string componentName;
    std::string productName;
    std::string representationName;
    std::string nameSource;
    std::vector<std::string> nameCandidates;
    std::string layer;
    std::string originalStepLabel;
    std::string rawStepTargetId;
    std::string rawStepStyledItemId;
    std::string colourSource;
    std::string geometrySource;
  };
  std::vector<GlbMesh> glbMeshes;

  std::vector<int> primitiveMeshIndex;
  primitiveMeshIndex.reserve(primitives.size());

  for (const auto& primitive : primitives) {
    const Colour glbColour = convertColourForGlb(primitive.colour, colourSpace);
    const std::string matKey = colourKey(glbColour);
    const int materialIndex = materialByColour[matKey];

    if (primitive.isReused) {
      SharedMeshKey skey = { primitive.reuseKey, matKey };
      auto found = sharedMeshIndexByKey.find(skey);
      if (found == sharedMeshIndexByKey.end()) {
        // First occurrence of this prototype/material combination!
        // We write its accessor and mesh views to the buffer.
        MeshRefs meshRefs;
        
        const int positionView = addFloatBuffer(bin, views, primitive.positions, 34962);
        AccessorInfo positionAccessor;
        positionAccessor.bufferView = positionView;
        positionAccessor.componentType = 5126;
        positionAccessor.count = primitive.positions.size() / 3;
        positionAccessor.type = "VEC3";
        positionAccessor.min = primitive.min;
        positionAccessor.max = primitive.max;
        positionAccessor.hasMinMax = true;
        accessors.push_back(positionAccessor);
        meshRefs.positionAccessor = static_cast<int>(accessors.size() - 1);

        const int normalView = addFloatBuffer(bin, views, primitive.normals, 34962);
        AccessorInfo normalAccessor;
        normalAccessor.bufferView = normalView;
        normalAccessor.componentType = 5126;
        normalAccessor.count = primitive.normals.size() / 3;
        normalAccessor.type = "VEC3";
        accessors.push_back(normalAccessor);
        meshRefs.normalAccessor = static_cast<int>(accessors.size() - 1);

        const int indexView = addIndexBuffer(bin, views, primitive.indices);
        AccessorInfo indexAccessor;
        indexAccessor.bufferView = indexView;
        indexAccessor.componentType = 5125;
        indexAccessor.count = primitive.indices.size();
        indexAccessor.type = "SCALAR";
        accessors.push_back(indexAccessor);
        meshRefs.indexAccessor = static_cast<int>(accessors.size() - 1);

        meshRefs.material = materialIndex;

        int newMeshIndex = static_cast<int>(glbMeshes.size());
        sharedMeshIndexByKey[skey] = newMeshIndex;
        sharedMeshRefsByKey[skey] = meshRefs;

        GlbMesh m;
        m.name = primitive.name;
        m.refs = meshRefs;
        m.selectableId = primitive.instancePath;
        m.displayName = primitive.displayName;
        m.resolvedObjectName = primitive.resolvedObjectName;
        m.objectName = primitive.objectName;
        m.partName = primitive.partName;
        m.blockName = primitive.blockName;
        m.componentName = primitive.componentName;
        m.productName = primitive.productName;
        m.representationName = primitive.representationName;
        m.nameSource = primitive.nameSource;
        m.nameCandidates = primitive.nameCandidates;
        m.layer = primitive.layer;
        m.originalStepLabel = primitive.originalStepLabel;
        m.rawStepTargetId = primitive.rawStepTargetId;
        m.rawStepStyledItemId = primitive.rawStepStyledItemId;
        m.colourSource = primitive.colourSource;
        m.geometrySource = primitive.geometrySource;
        glbMeshes.push_back(m);

        primitiveMeshIndex.push_back(newMeshIndex);
      } else {
        // Share existing mesh index
        primitiveMeshIndex.push_back(found->second);
      }
    } else {
      // Non-reused primitive: write unique buffer views/accessors and mesh entry
      MeshRefs meshRefs;

      const int positionView = addFloatBuffer(bin, views, primitive.positions, 34962);
      AccessorInfo positionAccessor;
      positionAccessor.bufferView = positionView;
      positionAccessor.componentType = 5126;
      positionAccessor.count = primitive.positions.size() / 3;
      positionAccessor.type = "VEC3";
      positionAccessor.min = primitive.min;
      positionAccessor.max = primitive.max;
      positionAccessor.hasMinMax = true;
      accessors.push_back(positionAccessor);
      meshRefs.positionAccessor = static_cast<int>(accessors.size() - 1);

      const int normalView = addFloatBuffer(bin, views, primitive.normals, 34962);
      AccessorInfo normalAccessor;
      normalAccessor.bufferView = normalView;
      normalAccessor.componentType = 5126;
      normalAccessor.count = primitive.normals.size() / 3;
      normalAccessor.type = "VEC3";
      accessors.push_back(normalAccessor);
      meshRefs.normalAccessor = static_cast<int>(accessors.size() - 1);

      const int indexView = addIndexBuffer(bin, views, primitive.indices);
      AccessorInfo indexAccessor;
      indexAccessor.bufferView = indexView;
      indexAccessor.componentType = 5125;
      indexAccessor.count = primitive.indices.size();
      indexAccessor.type = "SCALAR";
      accessors.push_back(indexAccessor);
      meshRefs.indexAccessor = static_cast<int>(accessors.size() - 1);

      meshRefs.material = materialIndex;

      int newMeshIndex = static_cast<int>(glbMeshes.size());
      GlbMesh m;
      m.name = primitive.name;
      m.refs = meshRefs;
      m.selectableId = primitive.instancePath;
      m.displayName = primitive.displayName;
      m.resolvedObjectName = primitive.resolvedObjectName;
      m.objectName = primitive.objectName;
      m.partName = primitive.partName;
      m.blockName = primitive.blockName;
      m.componentName = primitive.componentName;
      m.productName = primitive.productName;
      m.representationName = primitive.representationName;
      m.nameSource = primitive.nameSource;
      m.nameCandidates = primitive.nameCandidates;
      m.layer = primitive.layer;
      m.originalStepLabel = primitive.originalStepLabel;
      m.rawStepTargetId = primitive.rawStepTargetId;
      m.rawStepStyledItemId = primitive.rawStepStyledItemId;
      m.colourSource = primitive.colourSource;
      m.geometrySource = primitive.geometrySource;
      glbMeshes.push_back(m);

      primitiveMeshIndex.push_back(newMeshIndex);
    }
  }

  alignBuffer(bin);

  std::ostringstream json;
  json << std::fixed << std::setprecision(6);
  json << "{";
  json << "\"asset\":{\"version\":\"2.0\",\"generator\":\"occt-xcaf-glb-spike\"},";
  json << "\"extras\":{\"colourSpace\":"; writeString(json, colourSpace.name); json << "},";
  json << "\"scene\":0,\"scenes\":[{\"nodes\":[";
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    if (i > 0) json << ",";
    json << i;
  }
  json << "]}],";

  json << "\"nodes\":[";
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    if (i > 0) json << ",";
    const auto& primitive = primitives[i];
    json << "{\"name\":";
    writeString(json, primitive.displayName);
    json << ",\"mesh\":" << primitiveMeshIndex[i];

    if (primitive.isReused) {
      json << ",\"matrix\":[";
      const gp_Trsf& t = primitive.transform;
      json << t.Value(1,1) << "," << t.Value(2,1) << "," << t.Value(3,1) << ",0.0,"
           << t.Value(1,2) << "," << t.Value(2,2) << "," << t.Value(3,2) << ",0.0,"
           << t.Value(1,3) << "," << t.Value(2,3) << "," << t.Value(3,3) << ",0.0,"
           << t.Value(1,4) << "," << t.Value(2,4) << "," << t.Value(3,4) << ",1.0";
      json << "]";
    }

    json << ",\"extras\":{";
    json << "\"stableObjectId\":"; writeString(json, primitive.stableObjectId); json << ",";
    json << "\"selectableId\":"; writeString(json, primitive.instancePath); json << ",";
    json << "\"parentObjectId\":"; writeString(json, primitive.instancePath); json << ",";
    json << "\"labelPath\":"; writeString(json, primitive.labelPath); json << ",";
    json << "\"xcafLabelPath\":"; writeString(json, primitive.labelPath); json << ",";
    json << "\"instancePath\":"; writeString(json, primitive.instancePath); json << ",";
    json << "\"displayName\":"; writeString(json, primitive.displayName); json << ",";
    json << "\"resolvedObjectName\":"; writeString(json, primitive.resolvedObjectName); json << ",";
    json << "\"objectName\":"; writeString(json, primitive.objectName); json << ",";
    json << "\"partName\":"; writeString(json, primitive.partName); json << ",";
    json << "\"blockName\":"; writeString(json, primitive.blockName); json << ",";
    json << "\"componentName\":"; writeString(json, primitive.componentName); json << ",";
    json << "\"productName\":"; writeString(json, primitive.productName); json << ",";
    json << "\"representationName\":"; writeString(json, primitive.representationName); json << ",";
    json << "\"nameSource\":"; writeString(json, primitive.nameSource); json << ",";
    json << "\"nameCandidates\":"; writeStringVector(json, primitive.nameCandidates, 20); json << ",";
    json << "\"layer\":"; writeString(json, primitive.layer); json << ",";
    json << "\"layerNames\":"; writeString(json, primitive.layer); json << ",";
    json << "\"colourSource\":"; writeString(json, primitive.colourSource); json << ",";
    json << "\"materialSource\":"; writeString(json, primitive.materialSource); json << ",";
    json << "\"colourLookupPath\":"; writeString(json, primitive.colourLookupPath); json << ",";
    json << "\"colourType\":"; writeString(json, primitive.colourType); json << ",";
    json << "\"fallbackReason\":"; writeString(json, primitive.fallbackReason); json << ",";
    json << "\"originalStepLabel\":"; writeString(json, primitive.originalStepLabel); json << ",";
    json << "\"referredLabelPath\":"; writeString(json, primitive.originalStepLabel); json << ",";
    json << "\"transformSource\":"; writeString(json, primitive.transformSource); json << ",";
    json << "\"labelRole\":"; writeString(json, primitive.labelRole); json << ",";
    json << "\"parentChain\":"; writeString(json, primitive.parentChain); json << ",";
    json << "\"instanceLabelLayers\":"; writeString(json, primitive.instanceLabelLayers); json << ",";
    json << "\"referredLabelLayers\":"; writeString(json, primitive.referredLabelLayers); json << ",";
    json << "\"ancestorLayers\":"; writeString(json, primitive.ancestorLayers); json << ",";
    json << "\"matchedSubshapeLayers\":"; writeString(json, primitive.matchedSubshapeLayers); json << ",";
    json << "\"matchedSubshapeLabelPath\":"; writeString(json, primitive.matchedSubshapeLabelPath); json << ",";
    json << "\"matchedSubshapeName\":"; writeString(json, primitive.matchedSubshapeName); json << ",";
    json << "\"matchedSubshapeNameSource\":"; writeString(json, primitive.matchedSubshapeNameSource); json << ",";
    json << "\"rawStepMappingConfidence\":"; writeString(json, primitive.rawStepMappingConfidence); json << ",";
    json << "\"rawStepStyledItemId\":"; writeString(json, primitive.rawStepStyledItemId); json << ",";
    json << "\"stepStyledItemId\":"; writeString(json, primitive.rawStepStyledItemId); json << ",";
    json << "\"rawStepTargetId\":"; writeString(json, primitive.rawStepTargetId); json << ",";
    json << "\"stepEntityIds\":["; writeString(json, primitive.rawStepTargetId); json << "],";
    json << "\"rawStepTargetType\":"; writeString(json, primitive.rawStepTargetType); json << ",";
    json << "\"rawStepTargetScope\":"; writeString(json, primitive.rawStepTargetScope); json << ",";
    json << "\"rawStepTargetPath\":"; writeString(json, primitive.rawStepTargetPath); json << ",";
    json << "\"rawStepRejectedReason\":"; writeString(json, primitive.rawStepRejectedReason); json << ",";
    json << "\"geometrySource\":"; writeString(json, primitive.geometrySource); json << ",";
    json << "\"faceCount\":" << primitive.faceCount;
    json << "}}";
  }
  json << "],";

  json << "\"materials\":[";
  for (std::size_t i = 0; i < materials.size(); ++i) {
    if (i > 0) json << ",";
    const auto& material = materials[i];
    json << "{\"name\":";
    writeString(json, material.source + "_" + std::to_string(i));
    json << ",\"pbrMetallicRoughness\":{\"baseColorFactor\":["
         << material.r << "," << material.g << "," << material.b << "," << material.a
         << "],\"metallicFactor\":0,\"roughnessFactor\":0.72},\"doubleSided\":true}";
  }
  json << "],";

  json << "\"meshes\":[";
  for (std::size_t i = 0; i < glbMeshes.size(); ++i) {
    if (i > 0) json << ",";
    const auto& gm = glbMeshes[i];
    json << "{\"name\":";
    writeString(json, gm.name);
    json << ",\"primitives\":[{\"attributes\":{\"POSITION\":" << gm.refs.positionAccessor
         << ",\"NORMAL\":" << gm.refs.normalAccessor
         << "},\"indices\":" << gm.refs.indexAccessor
         << ",\"material\":" << gm.refs.material
         << ",\"mode\":4,\"extras\":{";
    json << "\"selectableId\":"; writeString(json, gm.selectableId); json << ",";
    json << "\"parentObjectId\":"; writeString(json, gm.selectableId); json << ",";
    json << "\"displayName\":"; writeString(json, gm.displayName); json << ",";
    json << "\"resolvedObjectName\":"; writeString(json, gm.resolvedObjectName); json << ",";
    json << "\"objectName\":"; writeString(json, gm.objectName); json << ",";
    json << "\"partName\":"; writeString(json, gm.partName); json << ",";
    json << "\"blockName\":"; writeString(json, gm.blockName); json << ",";
    json << "\"componentName\":"; writeString(json, gm.componentName); json << ",";
    json << "\"productName\":"; writeString(json, gm.productName); json << ",";
    json << "\"representationName\":"; writeString(json, gm.representationName); json << ",";
    json << "\"nameSource\":"; writeString(json, gm.nameSource); json << ",";
    json << "\"nameCandidates\":"; writeStringVector(json, gm.nameCandidates, 20); json << ",";
    json << "\"layerNames\":"; writeString(json, gm.layer); json << ",";
    json << "\"xcafLabelPath\":"; writeString(json, gm.originalStepLabel); json << ",";
    json << "\"referredLabelPath\":"; writeString(json, gm.originalStepLabel); json << ",";
    json << "\"stepEntityIds\":["; writeString(json, gm.rawStepTargetId); json << "],";
    json << "\"stepStyledItemId\":"; writeString(json, gm.rawStepStyledItemId); json << ",";
    json << "\"colourSource\":"; writeString(json, gm.colourSource); json << ",";
    json << "\"geometrySource\":"; writeString(json, gm.geometrySource);
    json << "}}]}";
  }
  json << "],";

  json << "\"buffers\":[{\"byteLength\":" << bin.size() << "}],";
  json << "\"bufferViews\":[";
  for (std::size_t i = 0; i < views.size(); ++i) {
    if (i > 0) json << ",";
    json << "{\"buffer\":0,\"byteOffset\":" << views[i].offset
         << ",\"byteLength\":" << views[i].length
         << ",\"target\":" << views[i].target << "}";
  }
  json << "],";

  json << "\"accessors\":[";
  for (std::size_t i = 0; i < accessors.size(); ++i) {
    if (i > 0) json << ",";
    const auto& accessor = accessors[i];
    json << "{\"bufferView\":" << accessor.bufferView
         << ",\"componentType\":" << accessor.componentType
         << ",\"count\":" << accessor.count
         << ",\"type\":";
    writeString(json, accessor.type);
    if (accessor.hasMinMax) {
      json << ",\"min\":[" << accessor.min[0] << "," << accessor.min[1] << "," << accessor.min[2] << "]"
           << ",\"max\":[" << accessor.max[0] << "," << accessor.max[1] << "," << accessor.max[2] << "]";
    }
    json << "}";
  }
  json << "]";
  json << "}";

  std::string jsonText = json.str();
  while (jsonText.size() % 4 != 0) {
    jsonText.push_back(' ');
  }

  if (profiler) {
    profiler->endStage("GLB primitive generation", {
      {"primitives", std::to_string(primitives.size())},
      {"binBytes", std::to_string(bin.size())},
      {"jsonBytes", std::to_string(jsonText.size())}
    });
    profiler->startStage("GLB write");
  }

  std::ofstream out(outputPath, std::ios::binary);
  if (!out) {
    throw std::runtime_error("Could not open GLB path for writing: " + outputPath.string());
  }

  const std::uint32_t magic = 0x46546C67;
  const std::uint32_t version = 2;
  const std::uint32_t jsonLength = static_cast<std::uint32_t>(jsonText.size());
  const std::uint32_t binLength = static_cast<std::uint32_t>(bin.size());
  const std::uint32_t totalLength = 12 + 8 + jsonLength + 8 + binLength;
  const std::uint32_t jsonType = 0x4E4F534A;
  const std::uint32_t binType = 0x004E4942;

  out.write(reinterpret_cast<const char*>(&magic), sizeof(magic));
  out.write(reinterpret_cast<const char*>(&version), sizeof(version));
  out.write(reinterpret_cast<const char*>(&totalLength), sizeof(totalLength));
  out.write(reinterpret_cast<const char*>(&jsonLength), sizeof(jsonLength));
  out.write(reinterpret_cast<const char*>(&jsonType), sizeof(jsonType));
  out.write(jsonText.data(), static_cast<std::streamsize>(jsonText.size()));
  out.write(reinterpret_cast<const char*>(&binLength), sizeof(binLength));
  out.write(reinterpret_cast<const char*>(&binType), sizeof(binType));
  out.write(reinterpret_cast<const char*>(bin.data()), static_cast<std::streamsize>(bin.size()));

  if (profiler) {
    profiler->endStage("GLB write", {{"bytes", std::to_string(totalLength)}});
  }
}

std::vector<DefaultGroup> buildDefaultGroups(const std::vector<MeshPrimitive>& primitives) {
  std::map<std::string, DefaultGroup> groups;
  for (const auto& primitive : primitives) {
    if (primitive.materialSource != "default") {
      continue;
    }

    const std::string key =
        primitive.labelPath + "|" + primitive.displayName + "|" + primitive.layer + "|" +
        primitive.parentLabelPath + "|" + primitive.shapeType + "|" +
        (primitive.ancestorHasColour ? "ancestor" : "noancestor") + "|" +
        (primitive.faceOrSubshapeHasColour ? "facesubshape" : "nofacesubshape");

    auto& group = groups[key];
    if (group.primitives == 0) {
      group.labelPath = primitive.labelPath;
      group.displayName = primitive.displayName;
      group.layer = primitive.layer;
      group.parentLabelPath = primitive.parentLabelPath;
      group.shapeType = primitive.shapeType;
      group.ancestorHasColour = primitive.ancestorHasColour;
      group.faceOrSubshapeHasColour = primitive.faceOrSubshapeHasColour;
      group.fallbackReason = primitive.fallbackReason;
    }
    group.primitives += 1;
    group.triangles += primitive.indices.size() / 3;
  }

  std::vector<DefaultGroup> result;
  for (const auto& item : groups) {
    result.push_back(item.second);
  }
  std::sort(result.begin(), result.end(), [](const DefaultGroup& a, const DefaultGroup& b) {
    if (a.primitives != b.primitives) {
      return a.primitives > b.primitives;
    }
    return a.triangles > b.triangles;
  });
  return result;
}

std::vector<RepeatedComponentGroup> buildRepeatedComponentGroups(const std::vector<MeshPrimitive>& primitives) {
  std::map<std::string, RepeatedComponentGroup> groups;
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    const auto& primitive = primitives[i];
    const std::uint64_t primitiveTriangles = primitive.indices.size() / 3;
    const std::string key =
        primitive.displayName + "|" + primitive.originalStepLabel + "|" + primitive.originalStepName + "|" +
        primitive.layer + "|" + std::to_string(primitive.faceCount) + "|" + std::to_string(primitiveTriangles);

    auto& group = groups[key];
    if (group.primitives == 0) {
      group.key = key;
      group.displayName = primitive.displayName;
      group.originalStepLabel = primitive.originalStepLabel;
      group.originalStepName = primitive.originalStepName;
      group.layer = primitive.layer;
    }
    group.instancePaths.insert(primitive.instancePath);
    group.finalColours.insert(colourKey(primitive.colour));
    group.materialSources.insert(primitive.materialSource);
    group.colourSources.insert(primitive.colourSource);
    group.primitives += 1;
    group.defaultPrimitives += primitive.materialSource == "default" ? 1 : 0;
    group.triangles += primitiveTriangles;
    group.keywordMatch = group.keywordMatch || containsDiagnosticKeyword(primitive);
    group.primitiveIndices.push_back(i);
  }

  std::vector<RepeatedComponentGroup> result;
  for (const auto& item : groups) {
    const auto& group = item.second;
    if (group.instancePaths.size() > 1) {
      result.push_back(group);
    }
  }
  std::sort(result.begin(), result.end(), [](const RepeatedComponentGroup& a, const RepeatedComponentGroup& b) {
    const bool aMismatch = a.finalColours.size() > 1 || (a.defaultPrimitives > 0 && a.defaultPrimitives < a.primitives);
    const bool bMismatch = b.finalColours.size() > 1 || (b.defaultPrimitives > 0 && b.defaultPrimitives < b.primitives);
    if (aMismatch != bMismatch) {
      return aMismatch;
    }
    if (a.keywordMatch != b.keywordMatch) {
      return a.keywordMatch;
    }
    if (a.instancePaths.size() != b.instancePaths.size()) {
      return a.instancePaths.size() > b.instancePaths.size();
    }
    return a.triangles > b.triangles;
  });
  return result;
}

int repeatedMismatchCount(const std::vector<RepeatedComponentGroup>& groups) {
  int count = 0;
  for (const auto& group : groups) {
    if (group.finalColours.size() > 1 || (group.defaultPrimitives > 0 && group.defaultPrimitives < group.primitives)) {
      count += 1;
    }
  }
  return count;
}

void writeStringSet(std::ostream& out, const std::set<std::string>& values) {
  out << "[";
  bool first = true;
  for (const auto& value : values) {
    if (!first) out << ", ";
    first = false;
    writeString(out, value);
  }
  out << "]";
}

void writeStringVector(std::ostream& out, const std::vector<std::string>& values, const std::size_t limit = 0) {
  out << "[";
  bool first = true;
  std::set<std::string> seen;
  std::size_t written = 0;
  for (const auto& value : values) {
    if (value.empty()) {
      continue;
    }
    if (!seen.insert(value).second) {
      continue;
    }
    if (limit > 0 && written >= limit) {
      break;
    }
    if (!first) out << ", ";
    first = false;
    writeString(out, value);
    written += 1;
  }
  out << "]";
}

std::vector<FinalColourAudit> buildFinalColourAudit(
    const std::vector<MeshPrimitive>& primitives,
    const ColourSpaceConfig& colourSpace) {
  std::map<std::string, FinalColourAudit> grouped;
  for (const auto& primitive : primitives) {
    const Colour glbColour = convertColourForGlb(primitive.colour, colourSpace);
    auto& audit = grouped[colourKey(glbColour)];
    if (audit.primitives == 0) {
      audit.colour = glbColour;
      audit.hex = colourHex(glbColour);
      audit.materialName = primitive.colourSource + "_" + std::to_string(grouped.size() - 1);
    }
    audit.sources.insert(primitive.colourSource);
    audit.materialSources.insert(primitive.materialSource);
    audit.primitives += 1;
    audit.faces += primitive.faceCount;
    audit.triangles += primitive.indices.size() / 3;
  }

  std::vector<FinalColourAudit> result;
  for (const auto& item : grouped) {
    result.push_back(item.second);
  }
  std::sort(result.begin(), result.end(), [](const FinalColourAudit& a, const FinalColourAudit& b) {
    if (a.primitives != b.primitives) {
      return a.primitives > b.primitives;
    }
    return a.triangles > b.triangles;
  });
  return result;
}

void writeReport(
    const std::filesystem::path& outputPath,
    const std::string& inputPath,
    const Quality& quality,
    const ColourSpaceConfig& colourSpace,
    const ColourModeConfig& colourMode,
    const Stats& stats,
    const std::map<std::string, RawStepColourAudit>& rawStepColourAudit,
    const std::vector<MeshPrimitive>& primitives,
    const std::uintmax_t glbSize) {
  std::ofstream out(outputPath);
  if (!out) {
    throw std::runtime_error("Could not open report path for writing: " + outputPath.string());
  }

  out << std::fixed << std::setprecision(6);
  const auto defaultGroups = buildDefaultGroups(primitives);
  const auto repeatedGroups = buildRepeatedComponentGroups(primitives);
  const auto finalColourAudit = buildFinalColourAudit(primitives, colourSpace);
  const int repeatedMismatchGroups = repeatedMismatchCount(repeatedGroups);
  std::string colourModeDescription;
  std::string colourPriorityJson;
  if (colourMode.mode == ColourMode::XcafBaseline) {
    colourModeDescription = "Direct OpenCascade/XCAF metadata only: no raw STEP style material assignment, no layer-colour material assignment, no material/name/layer guessing, raw RGB written by default.";
    colourPriorityJson = "[\"face_surface\", \"face_generic\", \"subshape_label_surface\", \"subshape_label_generic\", \"subshape_shape_surface\", \"subshape_shape_generic\", \"owning_label_surface\", \"owning_label_generic\", \"owning_shape_surface\", \"owning_shape_generic\", \"referred_label_surface\", \"referred_label_generic\", \"instance_component_label_surface\", \"instance_component_label_generic\", \"explicit_inherited_ancestor_surface\", \"explicit_inherited_ancestor_generic\", \"default_neutral_grey\"]";
  } else if (colourMode.mode == ColourMode::StepPresentation) {
    colourModeDescription = "XCAF hierarchy, transforms, and direct colours remain primary; STEP presentation STYLED_ITEM colours are mapped to matching exported topology when the BREP/shell target evidence is exact.";
    colourPriorityJson = "[\"face_surface\", \"face_generic\", \"subshape_label_surface\", \"subshape_label_generic\", \"subshape_shape_surface\", \"subshape_shape_generic\", \"label_surface\", \"label_generic\", \"owning_shape_surface\", \"owning_shape_generic\", \"referred_label_surface\", \"referred_label_generic\", \"step_presentation_styled_item\", \"ancestor_surface\", \"ancestor_generic\", \"default_neutral_grey\"]";
  } else {
    colourModeDescription = "Experimental spike mode: legacy raw STEP style and layer-colour material assignment remain enabled for comparison.";
    colourPriorityJson = "[\"face_surface\", \"face_generic\", \"face_curve\", \"subshape_label_surface\", \"subshape_label_generic\", \"subshape_shape_surface\", \"subshape_shape_generic\", \"label_surface\", \"label_generic\", \"owning_shape_surface\", \"owning_shape_generic\", \"referred_label_surface\", \"referred_label_generic\", \"raw_step_styled_item\", \"ancestor_surface\", \"ancestor_generic\", \"subshape_layer_surface\", \"subshape_layer_generic\", \"layer_surface\", \"layer_generic\", \"default_neutral_grey\"]";
  }
  std::array<float, 3> globalMin = emptyMinBounds();
  std::array<float, 3> globalMax = emptyMaxBounds();
  for (const auto& primitive : primitives) {
    for (int axis = 0; axis < 3; ++axis) {
      globalMin[axis] = std::min(globalMin[axis], primitive.min[axis]);
      globalMax[axis] = std::max(globalMax[axis], primitive.max[axis]);
    }
  }
  std::vector<std::size_t> byTriangles(primitives.size());
  std::vector<std::size_t> byBounds(primitives.size());
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    byTriangles[i] = i;
    byBounds[i] = i;
  }
  std::sort(byTriangles.begin(), byTriangles.end(), [&](const std::size_t a, const std::size_t b) {
    return primitives[a].indices.size() > primitives[b].indices.size();
  });
  std::sort(byBounds.begin(), byBounds.end(), [&](const std::size_t a, const std::size_t b) {
    return bboxDiagonal(primitives[a]) > bboxDiagonal(primitives[b]);
  });
  out << "{\n";
  out << "  \"inputFile\": "; writeString(out, inputPath); out << ",\n";
  out << "  \"openCascadeVersion\": "; writeString(out, OCC_VERSION_COMPLETE); out << ",\n";
  out << "  \"outputs\": {\n";
  out << "    \"glb\": \"display.glb\",\n";
  out << "    \"report\": \"xcaf-report.json\",\n";
  out << "    \"log\": \"conversion.log\"\n";
  out << "  },\n";
  out << "  \"quality\": {\n";
  out << "    \"preset\": "; writeString(out, quality.name); out << ",\n";
  out << "    \"linearDeflection\": " << quality.linearDeflection << ",\n";
  out << "    \"angularDeflection\": " << quality.angularDeflection << ",\n";
  out << "    \"relative\": " << (quality.relative ? "true" : "false") << "\n";
  out << "  },\n";
  out << "  \"colourSpace\": {\n";
  out << "    \"mode\": "; writeString(out, colourSpace.name); out << ",\n";
  out << "    \"baseColorFactorValues\": "; writeString(out, colourSpace.mode == ColourSpaceMode::SrgbToLinear ? "sRGB STEP/XCAF display RGB converted to linear before GLB material write" : "raw STEP/XCAF RGB written directly to GLB material baseColorFactor"); out << ",\n";
  out << "    \"converted\": " << (colourSpace.mode == ColourSpaceMode::SrgbToLinear ? "true" : "false") << "\n";
  out << "  },\n";
  out << "  \"colourMode\": {\n";
  out << "    \"mode\": "; writeString(out, colourMode.name); out << ",\n";
  out << "    \"applyRawStepStyles\": " << (colourMode.applyRawStepStyles ? "true" : "false") << ",\n";
  out << "    \"applyLayerColours\": " << (colourMode.applyLayerColours ? "true" : "false") << ",\n";
  out << "    \"description\": "; writeString(out, colourModeDescription); out << "\n";
  out << "  },\n";
  out << "  \"colourPriority\": " << colourPriorityJson << ",\n";
  out << "  \"summary\": {\n";
  out << "    \"freeShapes\": " << stats.freeShapes << ",\n";
  out << "    \"labelsComponentsProcessed\": " << stats.labelsProcessed << ",\n";
  out << "    \"namedObjects\": " << stats.namedObjects << ",\n";
  out << "    \"colouredObjects\": " << stats.labelsWithColour << ",\n";
  out << "    \"uniqueColours\": " << stats.uniqueColours.size() << ",\n";
  out << "    \"layers\": " << stats.layers.size() << ",\n";
  out << "    \"shapesTessellated\": " << stats.shapesTessellated << ",\n";
  out << "    \"nodeCount\": " << primitives.size() << ",\n";
  out << "    \"meshesPrimitivesExported\": " << stats.primitivesExported << ",\n";
  out << "    \"primitiveCount\": " << stats.primitivesExported << ",\n";
  out << "    \"materialCount\": " << stats.uniqueColours.size() << ",\n";
  out << "    \"vertices\": " << stats.vertices << ",\n";
  out << "    \"triangles\": " << stats.triangles << ",\n";
  out << "    \"skippedShapes\": " << stats.skippedShapes << ",\n";
  out << "    \"failedShapes\": " << stats.failedShapes << ",\n";
  out << "    \"defaultMaterialUsage\": " << stats.defaultMaterialUses << ",\n";
  out << "    \"rawStepStyledItemFaceUses\": " << stats.rawStepColourUses << ",\n";
  out << "    \"rawStepAmbiguousRepresentationRejects\": " << stats.rawStepAmbiguousRepresentationRejects << ",\n";
  out << "    \"rawStepBroadRepresentationRejects\": " << stats.rawStepBroadRepresentationRejects << ",\n";
  out << "    \"reusedInstances\": " << stats.reusedInstances << ",\n";
  out << "    \"freshInstances\": " << stats.freshInstances << ",\n";
  out << "    \"tessellationCacheHits\": " << stats.tessellationCacheHits << ",\n";
  out << "    \"tessellationCacheMisses\": " << stats.tessellationCacheMisses << ",\n";
  out << "    \"uniqueStoredTriangles\": " << stats.uniqueStoredTriangles << ",\n";
  out << "    \"repeatedComponentGroups\": " << repeatedGroups.size() << ",\n";
  out << "    \"repeatedComponentColourMismatches\": " << repeatedMismatchGroups << ",\n";
  out << "    \"glbBytes\": " << glbSize << ",\n";
  out << "    \"conversionSeconds\": " << stats.conversionSeconds << "\n";
  out << "  },\n";
  out << "  \"globalBoundingBox\": {\"min\": ";
  writeVec3(out, globalMin);
  out << ", \"max\": ";
  writeVec3(out, globalMax);
  out << ", \"diagonal\": " << std::sqrt(
      std::pow(static_cast<double>(globalMax[0]) - globalMin[0], 2) +
      std::pow(static_cast<double>(globalMax[1]) - globalMin[1], 2) +
      std::pow(static_cast<double>(globalMax[2]) - globalMin[2], 2)) << "},\n";
  out << "  \"coloursBySource\": {";
  bool first = true;
  for (const auto& item : stats.coloursBySource) {
    if (!first) out << ", ";
    first = false;
    writeString(out, item.first);
    out << ": " << item.second;
  }
  out << "},\n";
  out << "  \"colouredPrimitivesBySource\": {";
  first = true;
  for (const auto& item : stats.materialSourceCounts) {
    if (!first) out << ", ";
    first = false;
    writeString(out, item.first);
    out << ": " << item.second;
  }
  out << "},\n";
  out << "  \"rawStepStyleResolver\": {\n";
  out << "    \"entitiesParsed\": " << stats.rawStepEntities << ",\n";
  out << "    \"styledItems\": " << stats.rawStepStyledItems << ",\n";
  out << "    \"colourRgbEntities\": " << stats.rawStepColours << ",\n";
  out << "    \"representationColourLinks\": " << stats.rawStepRepresentationColours << ",\n";
  out << "    \"styledItemFaceUses\": " << stats.rawStepColourUses << ",\n";
  out << "    \"mappingConfidenceCounts\": {";
  first = true;
  for (const auto& item : stats.rawStepMappingConfidenceCounts) {
    if (!first) out << ", ";
    first = false;
    writeString(out, item.first);
    out << ": " << item.second;
  }
  out << "},\n";
  out << "    \"applicationMode\": "; writeString(out, colourMode.applyRawStepStyles ? "strong-only raw styled items; exactly one strong styled topology/BREP target per named representation" : "diagnostic-only; raw STEP styles are not active material assignment in this colour mode"); out << ",\n";
  out << "    \"ambiguousRepresentationRejects\": " << stats.rawStepAmbiguousRepresentationRejects << ",\n";
  out << "    \"broadRepresentationRejects\": " << stats.rawStepBroadRepresentationRejects << ",\n";
  out << "    \"weakMappingsOverrideXcaf\": false,\n";
  out << "    \"method\": \"raw STEP COLOUR_RGB -> presentation style -> STYLED_ITEM target, then named shape representation graph to BREP/topology target; representation-level, weak, name-only, and ambiguous multi-target mappings are reported but not applied\"\n";
  out << "  },\n";
  out << "  \"finalGlbColourAudit\": [\n";
  for (std::size_t i = 0; i < finalColourAudit.size(); ++i) {
    const auto& audit = finalColourAudit[i];
    out << "    {";
    out << "\"rgbWrittenToGlb\": [" << audit.colour.r << ", " << audit.colour.g << ", " << audit.colour.b << ", " << audit.colour.a << "], ";
    out << "\"hex\": "; writeString(out, audit.hex); out << ", ";
    out << "\"materialName\": "; writeString(out, audit.materialName); out << ", ";
    out << "\"sources\": "; writeStringSet(out, audit.sources); out << ", ";
    out << "\"materialSources\": "; writeStringSet(out, audit.materialSources); out << ", ";
    out << "\"primitiveCount\": " << audit.primitives << ", ";
    out << "\"faceCount\": " << audit.faces << ", ";
    out << "\"triangleCount\": " << audit.triangles;
    out << "}" << (i + 1 < finalColourAudit.size() ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"rawStepColourAudit\": [\n";
  std::size_t rawAuditIndex = 0;
  for (const auto& [colourId, audit] : rawStepColourAudit) {
    const Colour linear = convertColourForGlb(audit.colour, ColourSpaceConfig{ColourSpaceMode::SrgbToLinear, "srgb-to-linear"});
    out << "    {";
    out << "\"colourId\": "; writeString(out, colourId); out << ", ";
    out << "\"rawRgb\": [" << audit.colour.r << ", " << audit.colour.g << ", " << audit.colour.b << ", " << audit.colour.a << "], ";
    out << "\"hexIfSrgb\": "; writeString(out, colourHex(audit.colour)); out << ", ";
    out << "\"linearConvertedRgb\": [" << linear.r << ", " << linear.g << ", " << linear.b << ", " << linear.a << "], ";
    out << "\"styledItemIds\": "; writeStringVector(out, audit.styledItemIds, 20); out << ", ";
    out << "\"mappedObjectNames\": "; writeStringVector(out, audit.mappedObjectNames, 20);
    out << "}" << (++rawAuditIndex < rawStepColourAudit.size() ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"rawStepDerivedComponents\": [\n";
  std::vector<std::size_t> rawDerivedIndexes;
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    if (primitives[i].materialSource == "raw_step_styled_item" ||
        primitives[i].materialSource == "step_presentation_styled_item") {
      rawDerivedIndexes.push_back(i);
    }
  }
  const std::size_t rawDerivedLimit = std::min<std::size_t>(120, rawDerivedIndexes.size());
  for (std::size_t i = 0; i < rawDerivedLimit; ++i) {
    const auto& primitive = primitives[rawDerivedIndexes[i]];
    out << "    {";
    out << "\"name\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"colour\": "; writeString(out, colourKey(primitive.colour)); out << ", ";
    out << "\"hex\": "; writeString(out, colourHex(primitive.colour)); out << ", ";
    out << "\"source\": "; writeString(out, primitive.colourSource); out << ", ";
    out << "\"styleId\": "; writeString(out, primitive.rawStepStyledItemId); out << ", ";
    out << "\"targetId\": "; writeString(out, primitive.rawStepTargetId); out << ", ";
    out << "\"targetType\": "; writeString(out, primitive.rawStepTargetType); out << ", ";
    out << "\"targetScope\": "; writeString(out, primitive.rawStepTargetScope); out << ", ";
    out << "\"targetPath\": "; writeString(out, primitive.rawStepTargetPath); out << ", ";
    out << "\"confidence\": "; writeString(out, primitive.rawStepMappingConfidence); out << ", ";
    out << "\"geometrySource\": "; writeString(out, primitive.geometrySource); out << ", ";
    out << "\"faces\": " << primitive.faceCount << ", ";
    out << "\"triangles\": " << (primitive.indices.size() / 3);
    out << "}" << (i + 1 < rawDerivedLimit ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"componentsStayedDefaultGrey\": [\n";
  std::vector<std::size_t> defaultGreyIndexes;
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    if (primitives[i].materialSource == "default") {
      defaultGreyIndexes.push_back(i);
    }
  }
  const std::size_t defaultGreyLimit = std::min<std::size_t>(120, defaultGreyIndexes.size());
  for (std::size_t i = 0; i < defaultGreyLimit; ++i) {
    const auto& primitive = primitives[defaultGreyIndexes[i]];
    out << "    {";
    out << "\"name\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"colour\": "; writeString(out, colourKey(primitive.colour)); out << ", ";
    out << "\"hex\": "; writeString(out, colourHex(primitive.colour)); out << ", ";
    out << "\"rawStepRejectedReason\": "; writeString(out, primitive.rawStepRejectedReason); out << ", ";
    out << "\"candidateColours\": "; writeString(out, primitive.candidateColours); out << ", ";
    out << "\"faces\": " << primitive.faceCount << ", ";
    out << "\"triangles\": " << (primitive.indices.size() / 3);
    out << "}" << (i + 1 < defaultGreyLimit ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"uniqueColourValues\": [";
  first = true;
  for (const auto& item : stats.uniqueColours) {
    if (!first) out << ", ";
    first = false;
    writeString(out, item);
  }
  out << "],\n";
  out << "  \"layerColourAvailability\": {\n";
  out << "    \"explicitLayerColourPrimitives\": " << (stats.materialSourceCounts.count("layer") ? stats.materialSourceCounts.at("layer") : 0) << ",\n";
  out << "    \"labelsWithLayerColourCandidates\": " << stats.labelsWithLayerColourCandidates << ",\n";
  out << "    \"subshapeLayerColourCandidates\": " << stats.subshapeLayerColourCandidates << ",\n";
  out << "    \"layerNamesAvailable\": " << (!stats.layers.empty() ? "true" : "false") << ",\n";
  out << "    \"layerColoursAvailable\": " << ((stats.labelsWithLayerColourCandidates > 0 || stats.subshapeLayerColourCandidates > 0) ? "true" : "false") << "\n";
  out << "  },\n";
  out << "  \"layers\": [";
  first = true;
  for (const auto& layer : stats.layers) {
    if (!first) out << ", ";
    first = false;
    writeString(out, layer);
  }
  out << "],\n";
  out << "  \"defaultPrimitiveGroups\": [\n";
  for (std::size_t i = 0; i < defaultGroups.size(); ++i) {
    const auto& group = defaultGroups[i];
    out << "    {";
    out << "\"labelPath\": "; writeString(out, group.labelPath); out << ", ";
    out << "\"displayName\": "; writeString(out, group.displayName); out << ", ";
    out << "\"layer\": "; writeString(out, group.layer); out << ", ";
    out << "\"parentLabelPath\": "; writeString(out, group.parentLabelPath); out << ", ";
    out << "\"shapeType\": "; writeString(out, group.shapeType); out << ", ";
    out << "\"ancestorHasColour\": " << (group.ancestorHasColour ? "true" : "false") << ", ";
    out << "\"faceOrSubshapeHasColour\": " << (group.faceOrSubshapeHasColour ? "true" : "false") << ", ";
    out << "\"primitives\": " << group.primitives << ", ";
    out << "\"triangles\": " << group.triangles << ", ";
    out << "\"fallbackReason\": "; writeString(out, group.fallbackReason);
    out << "}" << (i + 1 < defaultGroups.size() ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"topDefaultHeavyLabels\": [\n";
  const std::size_t topDefaultCount = std::min<std::size_t>(20, defaultGroups.size());
  for (std::size_t i = 0; i < topDefaultCount; ++i) {
    const auto& group = defaultGroups[i];
    out << "    {";
    out << "\"labelPath\": "; writeString(out, group.labelPath); out << ", ";
    out << "\"displayName\": "; writeString(out, group.displayName); out << ", ";
    out << "\"layer\": "; writeString(out, group.layer); out << ", ";
    out << "\"parentLabelPath\": "; writeString(out, group.parentLabelPath); out << ", ";
    out << "\"primitives\": " << group.primitives << ", ";
    out << "\"triangles\": " << group.triangles;
    out << "}" << (i + 1 < topDefaultCount ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"repeatedComponentColourMismatches\": [\n";
  std::vector<std::size_t> mismatchGroupIndexes;
  for (std::size_t i = 0; i < repeatedGroups.size(); ++i) {
    const auto& group = repeatedGroups[i];
    if (group.finalColours.size() > 1 || (group.defaultPrimitives > 0 && group.defaultPrimitives < group.primitives)) {
      mismatchGroupIndexes.push_back(i);
    }
  }
  const std::size_t mismatchLimit = std::min<std::size_t>(60, mismatchGroupIndexes.size());
  for (std::size_t outIndex = 0; outIndex < mismatchLimit; ++outIndex) {
    const auto& group = repeatedGroups[mismatchGroupIndexes[outIndex]];
    out << "    {";
    out << "\"displayName\": "; writeString(out, group.displayName); out << ", ";
    out << "\"originalStepLabel\": "; writeString(out, group.originalStepLabel); out << ", ";
    out << "\"originalStepName\": "; writeString(out, group.originalStepName); out << ", ";
    out << "\"layer\": "; writeString(out, group.layer); out << ", ";
    out << "\"instanceCount\": " << group.instancePaths.size() << ", ";
    out << "\"primitives\": " << group.primitives << ", ";
    out << "\"defaultPrimitives\": " << group.defaultPrimitives << ", ";
    out << "\"triangles\": " << group.triangles << ", ";
    out << "\"keywordMatch\": " << (group.keywordMatch ? "true" : "false") << ", ";
    out << "\"finalColours\": "; writeStringSet(out, group.finalColours); out << ", ";
    out << "\"materialSources\": "; writeStringSet(out, group.materialSources); out << ", ";
    out << "\"colourSources\": "; writeStringSet(out, group.colourSources); out << ", ";
    out << "\"instancePaths\": "; writeStringSet(out, group.instancePaths); out << ", ";
    out << "\"examples\": [";
    const std::size_t exampleLimit = std::min<std::size_t>(8, group.primitiveIndices.size());
    for (std::size_t exampleIndex = 0; exampleIndex < exampleLimit; ++exampleIndex) {
      const auto& primitive = primitives[group.primitiveIndices[exampleIndex]];
      if (exampleIndex > 0) out << ", ";
      out << "{";
      out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
      out << "\"colour\": "; writeString(out, colourKey(primitive.colour)); out << ", ";
      out << "\"materialSource\": "; writeString(out, primitive.materialSource); out << ", ";
      out << "\"colourSource\": "; writeString(out, primitive.colourSource); out << ", ";
      out << "\"colourTrace\": "; writeString(out, primitive.colourTrace);
      out << "}";
    }
    out << "]";
    out << "}" << (outIndex + 1 < mismatchLimit ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"siblingColourComparison\": [\n";
  const std::size_t siblingLimit = std::min<std::size_t>(80, repeatedGroups.size());
  for (std::size_t groupIndex = 0; groupIndex < siblingLimit; ++groupIndex) {
    const auto& group = repeatedGroups[groupIndex];
    const bool mismatch = group.finalColours.size() > 1 || (group.defaultPrimitives > 0 && group.defaultPrimitives < group.primitives);
    out << "    {";
    out << "\"displayName\": "; writeString(out, group.displayName); out << ", ";
    out << "\"originalStepLabel\": "; writeString(out, group.originalStepLabel); out << ", ";
    out << "\"originalStepName\": "; writeString(out, group.originalStepName); out << ", ";
    out << "\"topologySignature\": "; writeString(out, std::to_string(group.triangles) + " triangles across " + std::to_string(group.primitives) + " primitives"); out << ", ";
    out << "\"instanceCount\": " << group.instancePaths.size() << ", ";
    out << "\"mismatch\": " << (mismatch ? "true" : "false") << ", ";
    out << "\"defaultPrimitives\": " << group.defaultPrimitives << ", ";
    out << "\"finalColours\": "; writeStringSet(out, group.finalColours); out << ", ";
    out << "\"materialSources\": "; writeStringSet(out, group.materialSources); out << ", ";
    out << "\"colourSources\": "; writeStringSet(out, group.colourSources); out << ", ";
    out << "\"siblings\": [";
    const std::size_t siblingExampleLimit = std::min<std::size_t>(12, group.primitiveIndices.size());
    for (std::size_t exampleIndex = 0; exampleIndex < siblingExampleLimit; ++exampleIndex) {
      const auto& primitive = primitives[group.primitiveIndices[exampleIndex]];
      if (exampleIndex > 0) out << ", ";
      out << "{";
      out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
      out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
      out << "\"parentChain\": "; writeString(out, primitive.parentChain); out << ", ";
      out << "\"finalColour\": "; writeString(out, colourKey(primitive.colour)); out << ", ";
      out << "\"finalColourSource\": "; writeString(out, primitive.colourSource); out << ", ";
      out << "\"finalColourLookupPath\": "; writeString(out, primitive.exactColourLookupPath); out << ", ";
      out << "\"instanceLabelLayers\": "; writeString(out, primitive.instanceLabelLayers); out << ", ";
      out << "\"referredLabelLayers\": "; writeString(out, primitive.referredLabelLayers); out << ", ";
      out << "\"ancestorLayers\": "; writeString(out, primitive.ancestorLayers); out << ", ";
      out << "\"matchedSubshapeLayers\": "; writeString(out, primitive.matchedSubshapeLayers); out << ", ";
      out << "\"matchedSubshapeLabelPath\": "; writeString(out, primitive.matchedSubshapeLabelPath); out << ", ";
      out << "\"matchedSubshapeName\": "; writeString(out, primitive.matchedSubshapeName); out << ", ";
      out << "\"matchedSubshapeNameSource\": "; writeString(out, primitive.matchedSubshapeNameSource); out << ", ";
      out << "\"candidateColours\": "; writeString(out, primitive.candidateColours); out << ", ";
      out << "\"rawStepMappingConfidence\": "; writeString(out, primitive.rawStepMappingConfidence); out << ", ";
      out << "\"rawStepStyledItemId\": "; writeString(out, primitive.rawStepStyledItemId); out << ", ";
      out << "\"rawStepTargetId\": "; writeString(out, primitive.rawStepTargetId); out << ", ";
      out << "\"rawStepTargetType\": "; writeString(out, primitive.rawStepTargetType); out << ", ";
      out << "\"rawStepTargetScope\": "; writeString(out, primitive.rawStepTargetScope); out << ", ";
      out << "\"rawStepRejectedReason\": "; writeString(out, primitive.rawStepRejectedReason); out << ", ";
      out << "\"geometrySource\": "; writeString(out, primitive.geometrySource); out << ", ";
      out << "\"fallbackReason\": "; writeString(out, primitive.fallbackReason);
      out << "}";
    }
    out << "]";
    out << "}" << (groupIndex + 1 < siblingLimit ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"diagnosticNameMatches\": [\n";
  std::vector<std::size_t> diagnosticIndexes;
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    if (containsDiagnosticKeyword(primitives[i])) {
      diagnosticIndexes.push_back(i);
    }
  }
  const std::size_t diagnosticLimit = std::min<std::size_t>(120, diagnosticIndexes.size());
  for (std::size_t i = 0; i < diagnosticLimit; ++i) {
    const auto& primitive = primitives[diagnosticIndexes[i]];
    out << "    {";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"displayName\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"resolvedObjectName\": "; writeString(out, primitive.resolvedObjectName); out << ", ";
    out << "\"objectName\": "; writeString(out, primitive.objectName); out << ", ";
    out << "\"partName\": "; writeString(out, primitive.partName); out << ", ";
    out << "\"blockName\": "; writeString(out, primitive.blockName); out << ", ";
    out << "\"componentName\": "; writeString(out, primitive.componentName); out << ", ";
    out << "\"productName\": "; writeString(out, primitive.productName); out << ", ";
    out << "\"representationName\": "; writeString(out, primitive.representationName); out << ", ";
    out << "\"nameSource\": "; writeString(out, primitive.nameSource); out << ", ";
    out << "\"nameCandidates\": "; writeStringVector(out, primitive.nameCandidates, 20); out << ", ";
    out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
    out << "\"originalStepLabel\": "; writeString(out, primitive.originalStepLabel); out << ", ";
    out << "\"originalStepName\": "; writeString(out, primitive.originalStepName); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"finalColour\": "; writeString(out, colourKey(primitive.colour)); out << ", ";
    out << "\"colourSource\": "; writeString(out, primitive.colourSource); out << ", ";
    out << "\"materialSource\": "; writeString(out, primitive.materialSource); out << ", ";
    out << "\"labelRole\": "; writeString(out, primitive.labelRole); out << ", ";
    out << "\"parentChain\": "; writeString(out, primitive.parentChain); out << ", ";
    out << "\"instanceLabelLayers\": "; writeString(out, primitive.instanceLabelLayers); out << ", ";
    out << "\"referredLabelLayers\": "; writeString(out, primitive.referredLabelLayers); out << ", ";
    out << "\"ancestorLayers\": "; writeString(out, primitive.ancestorLayers); out << ", ";
    out << "\"matchedSubshapeLayers\": "; writeString(out, primitive.matchedSubshapeLayers); out << ", ";
    out << "\"matchedSubshapeLabelPath\": "; writeString(out, primitive.matchedSubshapeLabelPath); out << ", ";
    out << "\"matchedSubshapeName\": "; writeString(out, primitive.matchedSubshapeName); out << ", ";
    out << "\"matchedSubshapeNameSource\": "; writeString(out, primitive.matchedSubshapeNameSource); out << ", ";
    out << "\"candidateColours\": "; writeString(out, primitive.candidateColours); out << ", ";
    out << "\"rawStepMappingConfidence\": "; writeString(out, primitive.rawStepMappingConfidence); out << ", ";
    out << "\"rawStepStyledItemId\": "; writeString(out, primitive.rawStepStyledItemId); out << ", ";
    out << "\"rawStepTargetId\": "; writeString(out, primitive.rawStepTargetId); out << ", ";
    out << "\"rawStepTargetType\": "; writeString(out, primitive.rawStepTargetType); out << ", ";
    out << "\"rawStepTargetScope\": "; writeString(out, primitive.rawStepTargetScope); out << ", ";
    out << "\"rawStepRejectedReason\": "; writeString(out, primitive.rawStepRejectedReason); out << ", ";
    out << "\"geometrySource\": "; writeString(out, primitive.geometrySource); out << ", ";
    out << "\"colourTrace\": "; writeString(out, primitive.colourTrace);
    out << "}" << (i + 1 < diagnosticLimit ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"topObjectsByTriangleCount\": [\n";
  const std::size_t topTriangleCount = std::min<std::size_t>(20, byTriangles.size());
  for (std::size_t i = 0; i < topTriangleCount; ++i) {
    const auto& primitive = primitives[byTriangles[i]];
    out << "    {";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"displayName\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
    out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"materialSource\": "; writeString(out, primitive.materialSource); out << ", ";
    out << "\"triangles\": " << (primitive.indices.size() / 3) << ", ";
    out << "\"faces\": " << primitive.faceCount;
    out << "}" << (i + 1 < topTriangleCount ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"topObjectsByBoundingBoxSize\": [\n";
  const std::size_t topBoundsCount = std::min<std::size_t>(20, byBounds.size());
  for (std::size_t i = 0; i < topBoundsCount; ++i) {
    const auto& primitive = primitives[byBounds[i]];
    out << "    {";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"displayName\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
    out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"diagonal\": " << bboxDiagonal(primitive) << ", ";
    out << "\"min\": "; writeVec3(out, primitive.min); out << ", ";
    out << "\"max\": "; writeVec3(out, primitive.max);
    out << "}" << (i + 1 < topBoundsCount ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"transformSamples\": [\n";
  const std::size_t transformSampleCount = std::min<std::size_t>(80, primitives.size());
  for (std::size_t i = 0; i < transformSampleCount; ++i) {
    const auto& primitive = primitives[i];
    out << "    {";
    out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
    out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
    out << "\"displayName\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"transformSource\": "; writeString(out, primitive.transformSource); out << ", ";
    out << "\"localTransform\": "; writeString(out, primitive.localTransform); out << ", ";
    out << "\"accumulatedTransform\": "; writeString(out, primitive.accumulatedTransform); out << ", ";
    out << "\"originalStepLabel\": "; writeString(out, primitive.originalStepLabel);
    out << "}" << (i + 1 < transformSampleCount ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"objects\": [\n";
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    const auto& primitive = primitives[i];
    out << "    {";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
    out << "\"instancePath\": "; writeString(out, primitive.instancePath); out << ", ";
    out << "\"displayName\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"resolvedObjectName\": "; writeString(out, primitive.resolvedObjectName); out << ", ";
    out << "\"objectName\": "; writeString(out, primitive.objectName); out << ", ";
    out << "\"partName\": "; writeString(out, primitive.partName); out << ", ";
    out << "\"blockName\": "; writeString(out, primitive.blockName); out << ", ";
    out << "\"componentName\": "; writeString(out, primitive.componentName); out << ", ";
    out << "\"productName\": "; writeString(out, primitive.productName); out << ", ";
    out << "\"representationName\": "; writeString(out, primitive.representationName); out << ", ";
    out << "\"nameSource\": "; writeString(out, primitive.nameSource); out << ", ";
    out << "\"nameCandidates\": "; writeStringVector(out, primitive.nameCandidates, 20); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"finalColour\": "; writeString(out, colourKey(primitive.colour)); out << ", ";
    out << "\"colourSource\": "; writeString(out, primitive.colourSource); out << ", ";
    out << "\"materialSource\": "; writeString(out, primitive.materialSource); out << ", ";
    out << "\"colourLookupPath\": "; writeString(out, primitive.colourLookupPath); out << ", ";
    out << "\"exactColourLookupPath\": "; writeString(out, primitive.exactColourLookupPath); out << ", ";
    out << "\"colourType\": "; writeString(out, primitive.colourType); out << ", ";
    out << "\"fallbackReason\": "; writeString(out, primitive.fallbackReason); out << ", ";
    out << "\"colourTrace\": "; writeString(out, primitive.colourTrace); out << ", ";
    out << "\"labelRole\": "; writeString(out, primitive.labelRole); out << ", ";
    out << "\"parentChain\": "; writeString(out, primitive.parentChain); out << ", ";
    out << "\"instanceLabelLayers\": "; writeString(out, primitive.instanceLabelLayers); out << ", ";
    out << "\"referredLabelLayers\": "; writeString(out, primitive.referredLabelLayers); out << ", ";
    out << "\"ancestorLayers\": "; writeString(out, primitive.ancestorLayers); out << ", ";
    out << "\"matchedSubshapeLayers\": "; writeString(out, primitive.matchedSubshapeLayers); out << ", ";
    out << "\"matchedSubshapeLabelPath\": "; writeString(out, primitive.matchedSubshapeLabelPath); out << ", ";
    out << "\"matchedSubshapeName\": "; writeString(out, primitive.matchedSubshapeName); out << ", ";
    out << "\"matchedSubshapeNameSource\": "; writeString(out, primitive.matchedSubshapeNameSource); out << ", ";
    out << "\"candidateColours\": "; writeString(out, primitive.candidateColours); out << ", ";
    out << "\"rawStepMappingConfidence\": "; writeString(out, primitive.rawStepMappingConfidence); out << ", ";
    out << "\"rawStepStyledItemId\": "; writeString(out, primitive.rawStepStyledItemId); out << ", ";
    out << "\"rawStepTargetId\": "; writeString(out, primitive.rawStepTargetId); out << ", ";
    out << "\"rawStepTargetType\": "; writeString(out, primitive.rawStepTargetType); out << ", ";
    out << "\"rawStepTargetScope\": "; writeString(out, primitive.rawStepTargetScope); out << ", ";
    out << "\"rawStepTargetPath\": "; writeString(out, primitive.rawStepTargetPath); out << ", ";
    out << "\"rawStepRejectedReason\": "; writeString(out, primitive.rawStepRejectedReason); out << ", ";
    out << "\"instanceLabelColour\": "; writeString(out, primitive.instanceLabelColour); out << ", ";
    out << "\"referredLabelColour\": "; writeString(out, primitive.referredLabelColour); out << ", ";
    out << "\"owningShapeColour\": "; writeString(out, primitive.owningShapeColour); out << ", ";
    out << "\"ancestorColour\": "; writeString(out, primitive.ancestorColour); out << ", ";
    out << "\"layerColour\": "; writeString(out, primitive.layerColour); out << ", ";
    out << "\"subshapeColourCandidates\": " << primitive.subshapeColourCandidates << ", ";
    out << "\"originalStepLabel\": "; writeString(out, primitive.originalStepLabel); out << ", ";
    out << "\"originalStepName\": "; writeString(out, primitive.originalStepName); out << ", ";
    out << "\"parentLabelPath\": "; writeString(out, primitive.parentLabelPath); out << ", ";
    out << "\"shapeType\": "; writeString(out, primitive.shapeType); out << ", ";
    out << "\"geometrySource\": "; writeString(out, primitive.geometrySource); out << ", ";
    out << "\"transformSource\": "; writeString(out, primitive.transformSource); out << ", ";
    out << "\"localTransform\": "; writeString(out, primitive.localTransform); out << ", ";
    out << "\"accumulatedTransform\": "; writeString(out, primitive.accumulatedTransform); out << ", ";
    out << "\"ancestorHasColour\": " << (primitive.ancestorHasColour ? "true" : "false") << ", ";
    out << "\"faceOrSubshapeHasColour\": " << (primitive.faceOrSubshapeHasColour ? "true" : "false") << ", ";
    out << "\"faces\": " << primitive.faceCount << ", ";
    out << "\"boundingBox\": {\"min\": "; writeVec3(out, primitive.min); out << ", \"max\": "; writeVec3(out, primitive.max); out << ", \"diagonal\": " << bboxDiagonal(primitive) << "}, ";
    out << "\"triangles\": " << (primitive.indices.size() / 3);
    out << "}" << (i + 1 < primitives.size() ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"simpleVsAssemblyColourComparison\": {\n";
  out << "    \"status\": \"per-run placeholder\",\n";
  out << "    \"method\": \"Compare this report with a second baseline report using objects, layers, candidateColours, finalGlbColourAudit, and rawStepColourAudit. The converter records the fields needed for the simple-object versus full-assembly investigation but does not know the paired report at conversion time.\",\n";
  out << "    \"simpleTestObjectMetadata\": null,\n";
  out << "    \"matchingCandidateComponentsInFullAssembly\": [],\n";
  out << "    \"colourCandidates\": [],\n";
  out << "    \"finalColours\": [],\n";
  out << "    \"hierarchyDifferences\": [],\n";
  out << "    \"conclusion\": \"Generated after both baseline reports are compared.\"\n";
  out << "  },\n";
  out << "  \"limitations\": [\n";
  out << "    \"Prototype writes one GLB node per component/material bucket, with duplicated triangle vertices to preserve sharp CAD normals and face colour identity.\",\n";
  out << "    \"Assembly hierarchy is flattened to renderable nodes; label paths and stableObjectId are preserved in node extras for later selection work.\",\n";
  out << "    \"Material rules are not used; uncoloured geometry receives a neutral grey fallback.\"\n";
  out << "  ]\n";
  out << "}\n";
}

void writeMaterialStyleProfile(const std::filesystem::path& path,
                               const RawStepStyleResolver& styles,
                               const Stats& stats) {
  std::ofstream out(path);
  if (!out) return;
  out << "{\n";
  out << "  \"summary\": {\n";
  out << "    \"entities\": " << stats.rawStepEntities << ",\n";
  out << "    \"styledItems\": " << stats.rawStepStyledItems << ",\n";
  out << "    \"colours\": " << stats.rawStepColours << ",\n";
  out << "    \"representationColours\": " << stats.rawStepRepresentationColours << ",\n";
  out << "    \"colourUses\": " << stats.rawStepColourUses << ",\n";
  out << "    \"ambiguousRejects\": " << stats.rawStepAmbiguousRepresentationRejects << ",\n";
  out << "    \"broadRejects\": " << stats.rawStepBroadRepresentationRejects << "\n";
  out << "  },\n";
  out << "  \"colourAudit\": [\n";
  size_t auditIndex = 0;
  for (const auto& [id, audit] : styles.colourAudit()) {
    out << "    {\n";
    out << "      \"colourId\": \"" << jsonEscape(audit.colourId) << "\",\n";
    out << "      \"colour\": [" << audit.colour.r << ", " << audit.colour.g << ", " << audit.colour.b << ", " << audit.colour.a << "],\n";
    out << "      \"styledItemIds\": [\n";
    for (size_t k = 0; k < audit.styledItemIds.size(); ++k) {
      out << "        \"" << jsonEscape(audit.styledItemIds[k]) << "\"";
      if (k + 1 < audit.styledItemIds.size()) out << ",";
      out << "\n";
    }
    out << "      ],\n";
    out << "      \"mappedObjectNames\": [\n";
    for (size_t k = 0; k < audit.mappedObjectNames.size(); ++k) {
      out << "        \"" << jsonEscape(audit.mappedObjectNames[k]) << "\"";
      if (k + 1 < audit.mappedObjectNames.size()) out << ",";
      out << "\n";
    }
    out << "      ]\n";
    out << "    }";
    if (++auditIndex < styles.colourAudit().size()) out << ",";
    out << "\n";
  }
  out << "  ]\n";
  out << "}\n";
}

struct LeafInstance {
  TDF_Label label;
  TDF_Label referred;
  TopoDS_Shape sourceShape;
  TopLoc_Location parentAccumulatedLocation;
  TopLoc_Location childAccumulatedLocation;
  std::string instancePath;
  std::string displayName;
  std::string parentChain;
  std::string parentDisplayName;
  std::string parentProductName;
  std::vector<LayerInfo> inheritedLayers;
  Colour inheritedColour;
  bool hasInheritedColour = false;
  std::string transformSource;
};

void collectLeafInstances(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const RawStepStyleResolver* rawStepStyles,
    const CliOptions& cliOptions,
    const TDF_Label& label,
    const Quality& quality,
    const std::string& instancePath,
    const TopLoc_Location& accumulatedLocation,
    const std::string& transformSource,
    const bool hasInheritedColour,
    const Colour& inheritedColour,
    const std::vector<LayerInfo>& inheritedLayers,
    const std::string& parentChain,
    const std::string& parentDisplayName,
    const std::string& parentProductName,
    std::vector<LeafInstance>& leafInstances) {

  TDF_LabelSequence children;
  const std::string labelPath = labelEntry(label);
  const std::string currentInstancePath = appendInstancePath(instancePath, labelPath);
  TDF_Label currentReferred;
  if (shapeTool->IsReference(label)) {
    shapeTool->GetReferredShape(label, currentReferred);
  }
  const auto currentLayers = collectLabelAndReferredLayers(layerTool, label, currentReferred);
  const auto childInheritedLayers = mergeLayers(inheritedLayers, currentLayers);
  const std::string currentParentChain = appendChain(parentChain, labelPath);
  bool hasChildren = shapeTool->GetComponents(label, children, Standard_False);
  TopLoc_Location childAccumulatedLocation = accumulatedLocation;
  std::string childTransformSource = transformSource;
  if (!hasChildren && shapeTool->IsReference(label)) {
    TDF_Label referred;
    if (shapeTool->GetReferredShape(label, referred)) {
      hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
      const TopLoc_Location referenceLocation = shapeLocation(shapeTool, label);
      childAccumulatedLocation = accumulatedLocation * referenceLocation;
      childTransformSource = "referred_assembly_instance";
    }
  }
  const std::string rawProductName = rawStepStyles == nullptr ? "" : rawStepStyles->uniqueProductName();
  const std::string currentProductName = safeName(parentProductName, hasChildren ? rawProductName : "");
  const std::string currentDisplayName = safeName(
      readableLabelName(label),
      safeName(currentProductName, safeName(readableLabelName(currentReferred), parentDisplayName)));

  if (hasChildren && children.Length() > 0) {
    Colour childInherited = inheritedColour;
    bool childHasInherited = hasInheritedColour;
    if (firstColourForLabel(colourTool, label, "label_", "ancestor", childInherited)) {
      childHasInherited = true;
    } else if (shapeTool->IsReference(label)) {
      TDF_Label referred;
      if (shapeTool->GetReferredShape(label, referred) &&
          firstColourForLabel(colourTool, referred, "referred_label_", "ancestor", childInherited)) {
        childHasInherited = true;
      }
    }
    for (Standard_Integer i = 1; i <= children.Length(); ++i) {
      collectLeafInstances(
          shapeTool,
          colourTool,
          layerTool,
          rawStepStyles,
          cliOptions,
          children.Value(i),
          quality,
          currentInstancePath,
          childAccumulatedLocation,
          childTransformSource,
          childHasInherited,
          childInherited,
          childInheritedLayers,
          currentParentChain,
          currentDisplayName,
          currentProductName,
          leafInstances);
    }
    return;
  }

  TDF_Label referred;
  TopoDS_Shape sourceShape = shapeForLabel(shapeTool, label, referred);
  if (sourceShape.IsNull()) {
    return;
  }

  LeafInstance inst;
  inst.label = label;
  inst.referred = referred;
  inst.sourceShape = sourceShape;
  inst.parentAccumulatedLocation = accumulatedLocation;
  inst.childAccumulatedLocation = accumulatedLocation * sourceShape.Location();
  inst.instancePath = currentInstancePath;
  inst.displayName = currentDisplayName;
  inst.parentChain = parentChain;
  inst.parentDisplayName = parentDisplayName;
  inst.parentProductName = parentProductName;
  inst.inheritedLayers = childInheritedLayers;
  inst.inheritedColour = inheritedColour;
  inst.hasInheritedColour = hasInheritedColour;
  inst.transformSource = transformSource;
  leafInstances.push_back(inst);
}

Colour determineInstanceColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const RawStepStyleResolver* rawStepStyles,
    const CliOptions& cliOptions,
    const LeafInstance& inst) {
  Colour labelColour;
  bool labelHasColour = findLabelColour(colourTool, inst.label, labelColour);
  Colour owningShapeColour;
  const bool owningShapeHasColour = firstColourForShape(colourTool, inst.sourceShape, "owning_shape_", "label", labelEntry(inst.label), owningShapeColour);

  Colour referredColour;
  const bool referredHasColour = inst.referred.IsNull() ? false : referredLabelColour(colourTool, inst.referred, referredColour);
  
  Colour ancestorCandidate;
  const bool ancestorHasCandidateColour = nearestAncestorColour(inst.hasInheritedColour, inst.inheritedColour, ancestorCandidate);
  
  const auto instanceLayers = collectLayerInfos(layerTool, inst.label);
  const auto referredLayers = inst.referred.IsNull() ? std::vector<LayerInfo>() : collectLayerInfos(layerTool, inst.referred);
  const auto layers = mergeLayers(mergeLayers(instanceLayers, referredLayers), inst.inheritedLayers);
  Colour layerCandidate;
  const bool layerHasCandidateColour = layerColour(colourTool, layers, layerCandidate);

  RawStepStyleMatch rawStepMatch;
  RawStepStyleMatch rawStepRejectedMatch;
  Colour rawStepColour;
  const std::string displayName = inst.displayName;
  const std::string objectName = readableLabelName(inst.label);
  const std::string referredName = inst.referred.IsNull() ? "" : readableLabelName(inst.referred);
  const std::string layer = firstLayerName(layers);
  const std::string referredPath = inst.referred.IsNull() ? "" : labelEntry(inst.referred);
  const std::string labelPath = labelEntry(inst.label);
  const std::vector<std::string> rawStyleNames = {
      displayName, referredName, objectName, labelName(inst.label), referredPath, labelPath};

  const bool rawStepHasColour = !cliOptions.debugSkipRawStepStyles && rawStepStyles != nullptr &&
      rawStepStyles->findForNames(
          rawStyleNames,
          rawStepMatch,
          rawStepRejectedMatch);
  if (rawStepHasColour) {
    rawStepColour = rawStepMatch.colour;
    if (cliOptions.colourMode.mode == ColourMode::StepPresentation) {
      rawStepColour = linearizedStepPresentationColour(rawStepColour);
      rawStepColour.source = "step_presentation_styled_item";
      rawStepColour.materialSource = "step_presentation_styled_item";
    }
  }

  Colour colour;
  bool hasColour = labelHasColour;
  if (hasColour) {
    colour = labelColour;
  } else if (owningShapeHasColour) {
    colour = owningShapeColour;
    hasColour = true;
  } else if (referredHasColour) {
    colour = referredColour;
    hasColour = true;
  } else if (rawStepHasColour && cliOptions.colourMode.applyRawStepStyles) {
    colour = rawStepColour;
    hasColour = true;
  } else if (ancestorHasCandidateColour) {
    colour = ancestorCandidate;
    hasColour = true;
  } else if (layerHasCandidateColour && cliOptions.colourMode.applyLayerColours) {
    colour = layerCandidate;
    hasColour = true;
  }

  if (!hasColour) {
    colour = defaultColour(
        cliOptions.colourMode.mode == ColourMode::XcafBaseline
            ? "no direct XCAF face/subshape, owning label/body, referred/original label, instance/component label, or explicit inherited ancestor colour found; raw STEP styles and layer colours are diagnostic-only in xcaf-baseline"
            : "no face/subshape, label, referred-label, ancestor, or layer colour found",
        labelPath);
  }
  return colour;
}

bool hasFaceStyling(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const RawStepStyleResolver* rawStepStyles,
    const CliOptions& cliOptions,
    const LeafInstance& inst) {
  const std::string displayName = inst.displayName;
  const std::string objectName = readableLabelName(inst.label);
  const std::string referredName = inst.referred.IsNull() ? "" : readableLabelName(inst.referred);
  const std::string referredPath = inst.referred.IsNull() ? "" : labelEntry(inst.referred);
  const std::string labelPath = labelEntry(inst.label);
  const std::vector<std::string> rawStyleNames = {
      displayName, referredName, objectName, labelName(inst.label), referredPath, labelPath};

  RawStepStyleMatch rawStepRejectedMatch;
  const auto styledTopologyColours = cliOptions.debugSkipRawStepStyles ? std::vector<StyledTopologyColour>() : mapStepPresentationToSubshapes(
      rawStepStyles,
      cliOptions.colourMode,
      inst.sourceShape,
      rawStyleNames,
      rawStepRejectedMatch);
  if (!styledTopologyColours.empty()) {
    return true;
  }

  std::vector<SubshapeColourCandidate> subshapeColours;
  collectColouredSubshapes(shapeTool, colourTool, layerTool, inst.label, "subshape", subshapeColours);
  if (!inst.referred.IsNull()) {
    collectColouredSubshapes(shapeTool, colourTool, layerTool, inst.referred, "referred_subshape", subshapeColours);
  }
  if (!subshapeColours.empty()) {
    return true;
  }

  return false;
}

void writePrototypeReuseReport(
    const std::filesystem::path& outputPath,
    const std::vector<LeafInstance>& leafInstances,
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const RawStepStyleResolver* rawStepStyles,
    const CliOptions& cliOptions,
    const Quality& quality) {

  std::ofstream out(outputPath);
  if (!out) {
    throw std::runtime_error("Could not open prototype reuse report path for writing: " + outputPath.string());
  }
  out << std::fixed << std::setprecision(6);

  struct ProtoGroup {
    void* tshapePtr = nullptr;
    int faceCount = 0;
    int edgeCount = 0;
    int uniqueTriangles = 0;
    std::array<float, 6> localBbox = {0,0,0,0,0,0};
    std::vector<std::size_t> instanceIndices;
    std::set<std::string> materialSignatures;
    bool isSafeForLocalReuse = true;
    bool hasFaceStyling = false;
    std::string unsafeReason;
  };

  std::map<void*, ProtoGroup> protoGroups;

  // Track elapsed time for pre-meshing prototypes
  const auto premeshStart = std::chrono::steady_clock::now();

  for (std::size_t i = 0; i < leafInstances.size(); ++i) {
    const auto& inst = leafInstances[i];
    void* tshapePtr = inst.sourceShape.TShape().get();
    
    if (protoGroups.find(tshapePtr) == protoGroups.end()) {
      ProtoGroup group;
      group.tshapePtr = tshapePtr;
      
      TopoDS_Shape localShape = inst.sourceShape;
      localShape.Location(TopLoc_Location());
      
      // Face and edge count
      int fCount = 0;
      for (TopExp_Explorer exp(localShape, TopAbs_FACE); exp.More(); exp.Next()) fCount++;
      int eCount = 0;
      for (TopExp_Explorer exp(localShape, TopAbs_EDGE); exp.More(); exp.Next()) eCount++;
      group.faceCount = fCount;
      group.edgeCount = eCount;

      // Local bounding box
      Bnd_Box box;
      BRepBndLib::Add(localShape, box);
      Standard_Real xmin = 0, ymin = 0, zmin = 0, xmax = 0, ymax = 0, zmax = 0;
      if (!box.IsVoid()) {
        box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
      }
      group.localBbox = { (float)xmin, (float)ymin, (float)zmin, (float)xmax, (float)ymax, (float)zmax };

      // Pre-mesh the local shape once to get the exact triangle count
      try {
        BRepMesh_IncrementalMesh mesh(localShape, quality.linearDeflection, quality.relative, quality.angularDeflection, cliOptions.parallelMesh ? Standard_True : Standard_False);
        mesh.Perform();
        int triCount = 0;
        for (TopExp_Explorer exp(localShape, TopAbs_FACE); exp.More(); exp.Next()) {
          const TopoDS_Face face = TopoDS::Face(exp.Current());
          TopLoc_Location loc;
          Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
          if (!tri.IsNull()) {
            triCount += tri->NbTriangles();
          }
        }
        group.uniqueTriangles = triCount;
      } catch (...) {
        group.uniqueTriangles = 0;
      }

      protoGroups[tshapePtr] = group;
    }

    // Now populate instances
    auto& group = protoGroups[tshapePtr];
    group.instanceIndices.push_back(i);

    // Compute color/material signature
    bool faceStyle = hasFaceStyling(shapeTool, colourTool, layerTool, rawStepStyles, cliOptions, inst);
    std::string matSig;
    if (faceStyle) {
      matSig = "face-styled";
      group.hasFaceStyling = true;
    } else {
      Colour col = determineInstanceColour(colourTool, layerTool, rawStepStyles, cliOptions, inst);
      matSig = "color:" + colourKey(col);
    }
    group.materialSignatures.insert(matSig);

    bool isMirrored = inst.childAccumulatedLocation.Transformation().IsNegative();
    
    if (isMirrored || faceStyle) {
      group.isSafeForLocalReuse = false;
      if (isMirrored && faceStyle) {
        group.unsafeReason = "mirrored transform and per-face styling present";
      } else if (isMirrored) {
        group.unsafeReason = "mirrored/negative determinant transform";
      } else {
        group.unsafeReason = "per-face styling present";
      }
    }
  }

  const auto premeshEnd = std::chrono::steady_clock::now();
  double premeshMs = std::chrono::duration<double, std::milli>(premeshEnd - premeshStart).count();

  // Sort groups by instance count descending
  std::vector<void*> sortedTShapePtrs;
  for (const auto& pair : protoGroups) {
    sortedTShapePtrs.push_back(pair.first);
  }
  std::sort(sortedTShapePtrs.begin(), sortedTShapePtrs.end(), [&](void* a, void* b) {
    return protoGroups[a].instanceIndices.size() > protoGroups[b].instanceIndices.size();
  });

  // Calculate high level stats
  int totalInstances = static_cast<int>(leafInstances.size());
  int uniquePrototypes = static_cast<int>(protoGroups.size());
  int repeatedPrototypesCount = 0;
  int maxInstanceCount = 0;

  int instancedTrianglesAll = 0;
  int uniqueTrianglesAll = 0;

  for (const auto& pair : protoGroups) {
    const auto& group = pair.second;
    int instCount = static_cast<int>(group.instanceIndices.size());
    instancedTrianglesAll += group.uniqueTriangles * instCount;
    uniqueTrianglesAll += group.uniqueTriangles;

    if (instCount > 1) {
      repeatedPrototypesCount++;
    }
    maxInstanceCount = std::max(maxInstanceCount, instCount);
  }

  // Estimated duplicate tessellation waste
  int wasteTriangles = 0;
  int wasteShapesCount = 0;
  for (const auto& pair : protoGroups) {
    const auto& group = pair.second;
    if (group.isSafeForLocalReuse && group.instanceIndices.size() > 1) {
      int instances = static_cast<int>(group.instanceIndices.size());
      wasteShapesCount += (instances - 1);
      wasteTriangles += (instances - 1) * group.uniqueTriangles;
    }
  }

  // Count non-reusable shapes by reason
  int skippedMirroredCount = 0;
  int skippedFaceStyledCount = 0;
  for (const auto& inst : leafInstances) {
    bool isMirrored = inst.childAccumulatedLocation.Transformation().IsNegative();
    bool faceStyle = hasFaceStyling(shapeTool, colourTool, layerTool, rawStepStyles, cliOptions, inst);
    if (isMirrored) skippedMirroredCount++;
    else if (faceStyle) skippedFaceStyledCount++;
  }

  out << "{\n";
  out << "  \"totalTraversedLeafInstances\": " << totalInstances << ",\n";
  out << "  \"totalUniquePrototypeGeometryKeys\": " << uniquePrototypes << ",\n";
  out << "  \"repeatedPrototypeCount\": " << repeatedPrototypesCount << ",\n";
  out << "  \"maximumInstanceCount\": " << maxInstanceCount << ",\n";
  out << "  \"premeshDurationMs\": " << premeshMs << ",\n";

  // Triangle counts
  out << "  \"renderedTrianglesTotal\": " << instancedTrianglesAll << ",\n";
  out << "  \"uniqueStoredTrianglesTotal\": " << uniqueTrianglesAll << ",\n";

  // Waste section
  out << "  \"estimatedDuplicateTessellationWaste\": {\n";
  out << "    \"shapesThatCouldBeReused\": " << wasteShapesCount << ",\n";
  out << "    \"trianglesThatCouldBeSaved\": " << wasteTriangles << ",\n";
  out << "    \"shapesCannotBeReused\": {\n";
  out << "      \"mirroredOrNegativeTransform\": " << skippedMirroredCount << ",\n";
  out << "      \"perFaceStyling\": " << skippedFaceStyledCount << "\n";
  out << "    }\n";
  out << "  },\n";

  // Groups same material
  out << "  \"groupsSameGeometrySameMaterial\": [\n";
  int sameGroupIndex = 0;
  for (void* ptr : sortedTShapePtrs) {
    const auto& group = protoGroups[ptr];
    if (group.instanceIndices.size() > 1 && group.materialSignatures.size() == 1 && group.isSafeForLocalReuse) {
      if (sameGroupIndex > 0) out << ",\n";
      out << "    {\n";
      out << "      \"prototypeKey\": \"TShapePtr:" << ptr << "|Preset:" << quality.name << "|Safe:true\",\n";
      out << "      \"instanceCount\": " << group.instanceIndices.size() << ",\n";
      out << "      \"materialSignature\": "; writeString(out, *group.materialSignatures.begin()); out << ",\n";
      out << "      \"uniqueTriangles\": " << group.uniqueTriangles << ",\n";
      out << "      \"instancedTriangles\": " << (group.uniqueTriangles * group.instanceIndices.size()) << ",\n";
      out << "      \"displayNameExample\": "; writeString(out, leafInstances[group.instanceIndices[0]].displayName); out << ",\n";
      out << "      \"pathsExamples\": [\n";
      for (size_t k = 0; k < std::min(group.instanceIndices.size(), size_t(5)); ++k) {
        out << "        "; writeString(out, leafInstances[group.instanceIndices[k]].instancePath);
        if (k + 1 < std::min(group.instanceIndices.size(), size_t(5))) out << ",";
        out << "\n";
      }
      out << "      ]\n";
      out << "    }";
      sameGroupIndex++;
    }
  }
  out << "\n  ],\n";

  // Groups diff material
  out << "  \"groupsSameGeometryDifferentMaterial\": [\n";
  int diffGroupIndex = 0;
  for (void* ptr : sortedTShapePtrs) {
    const auto& group = protoGroups[ptr];
    if (group.instanceIndices.size() > 1 && group.materialSignatures.size() > 1 && group.isSafeForLocalReuse) {
      if (diffGroupIndex > 0) out << ",\n";
      out << "    {\n";
      out << "      \"prototypeKey\": \"TShapePtr:" << ptr << "|Preset:" << quality.name << "|Safe:true\",\n";
      out << "      \"instanceCount\": " << group.instanceIndices.size() << ",\n";
      out << "      \"materialSignaturesCount\": " << group.materialSignatures.size() << ",\n";
      out << "      \"materialSignatures\": [\n";
      size_t matIdx = 0;
      for (const auto& sig : group.materialSignatures) {
        out << "        "; writeString(out, sig);
        if (++matIdx < group.materialSignatures.size()) out << ",";
        out << "\n";
      }
      out << "      ],\n";
      out << "      \"uniqueTriangles\": " << group.uniqueTriangles << ",\n";
      out << "      \"instancedTriangles\": " << (group.uniqueTriangles * group.instanceIndices.size()) << ",\n";
      out << "      \"displayNameExample\": "; writeString(out, leafInstances[group.instanceIndices[0]].displayName); out << ",\n";
      out << "      \"pathsExamples\": [\n";
      for (size_t k = 0; k < std::min(group.instanceIndices.size(), size_t(5)); ++k) {
        out << "        "; writeString(out, leafInstances[group.instanceIndices[k]].instancePath);
        if (k + 1 < std::min(group.instanceIndices.size(), size_t(5))) out << ",";
        out << "\n";
      }
      out << "      ]\n";
      out << "    }";
      diffGroupIndex++;
    }
  }
  out << "\n  ],\n";

  // Groups mirrored
  out << "  \"groupsSameGeometryMirrored\": [\n";
  int mirroredGroupIndex = 0;
  for (void* ptr : sortedTShapePtrs) {
    const auto& group = protoGroups[ptr];
    bool hasMirroredInstance = false;
    for (size_t idx : group.instanceIndices) {
      if (leafInstances[idx].childAccumulatedLocation.Transformation().IsNegative()) {
        hasMirroredInstance = true;
        break;
      }
    }
    if (group.instanceIndices.size() > 1 && hasMirroredInstance) {
      if (mirroredGroupIndex > 0) out << ",\n";
      out << "    {\n";
      out << "      \"prototypeKey\": \"TShapePtr:" << ptr << "|Preset:" << quality.name << "|Safe:false\",\n";
      out << "      \"instanceCount\": " << group.instanceIndices.size() << ",\n";
      out << "      \"uniqueTriangles\": " << group.uniqueTriangles << ",\n";
      out << "      \"instancedTriangles\": " << (group.uniqueTriangles * group.instanceIndices.size()) << ",\n";
      out << "      \"displayNameExample\": "; writeString(out, leafInstances[group.instanceIndices[0]].displayName); out << ",\n";
      out << "      \"pathsExamples\": [\n";
      for (size_t k = 0; k < std::min(group.instanceIndices.size(), size_t(5)); ++k) {
        out << "        "; writeString(out, leafInstances[group.instanceIndices[k]].instancePath);
        if (k + 1 < std::min(group.instanceIndices.size(), size_t(5))) out << ",";
        out << "\n";
      }
      out << "      ]\n";
      out << "    }";
      mirroredGroupIndex++;
    }
  }
  out << "\n  ],\n";

  // Groups unsafe
  out << "  \"groupsSameGeometryUnsafeToReuse\": [\n";
  int unsafeGroupIndex = 0;
  for (void* ptr : sortedTShapePtrs) {
    const auto& group = protoGroups[ptr];
    if (group.instanceIndices.size() > 1 && !group.isSafeForLocalReuse) {
      if (unsafeGroupIndex > 0) out << ",\n";
      out << "    {\n";
      out << "      \"prototypeKey\": \"TShapePtr:" << ptr << "|Preset:" << quality.name << "|Safe:false\",\n";
      out << "      \"instanceCount\": " << group.instanceIndices.size() << ",\n";
      out << "      \"unsafeReason\": "; writeString(out, group.unsafeReason); out << ",\n";
      out << "      \"uniqueTriangles\": " << group.uniqueTriangles << ",\n";
      out << "      \"instancedTriangles\": " << (group.uniqueTriangles * group.instanceIndices.size()) << ",\n";
      out << "      \"displayNameExample\": "; writeString(out, leafInstances[group.instanceIndices[0]].displayName); out << ",\n";
      out << "      \"pathsExamples\": [\n";
      for (size_t k = 0; k < std::min(group.instanceIndices.size(), size_t(5)); ++k) {
        out << "        "; writeString(out, leafInstances[group.instanceIndices[k]].instancePath);
        if (k + 1 < std::min(group.instanceIndices.size(), size_t(5))) out << ",";
        out << "\n";
      }
      out << "      ]\n";
      out << "    }";
      unsafeGroupIndex++;
    }
  }
  out << "\n  ],\n";

  // Top 50 repeated
  out << "  \"topRepeatedPrototypes\": [\n";
  int printedCount = 0;
  for (void* ptr : sortedTShapePtrs) {
    const auto& group = protoGroups[ptr];
    if (group.instanceIndices.size() > 1) {
      if (printedCount > 0) out << ",\n";
      out << "    {\n";
      out << "      \"prototypeKey\": \"TShapePtr:" << ptr << "|Preset:" << quality.name << "|Safe:" << (group.isSafeForLocalReuse ? "true" : "false") << "\",\n";
      out << "      \"instanceCount\": " << group.instanceIndices.size() << ",\n";
      out << "      \"faceCount\": " << group.faceCount << ",\n";
      out << "      \"edgeCount\": " << group.edgeCount << ",\n";
      out << "      \"uniqueTriangles\": " << group.uniqueTriangles << ",\n";
      out << "      \"instancedTriangles\": " << (group.uniqueTriangles * group.instanceIndices.size()) << ",\n";
      out << "      \"materialSignaturesCount\": " << group.materialSignatures.size() << ",\n";
      out << "      \"displayNameExample\": "; writeString(out, leafInstances[group.instanceIndices[0]].displayName); out << ",\n";
      out << "      \"localBbox\": [" << group.localBbox[0] << "," << group.localBbox[1] << "," << group.localBbox[2] << ","
          << group.localBbox[3] << "," << group.localBbox[4] << "," << group.localBbox[5] << "],\n";
      out << "      \"pathsExamples\": [\n";
      for (size_t k = 0; k < std::min(group.instanceIndices.size(), size_t(3)); ++k) {
        out << "        "; writeString(out, leafInstances[group.instanceIndices[k]].instancePath);
        if (k + 1 < std::min(group.instanceIndices.size(), size_t(3))) out << ",";
        out << "\n";
      }
      out << "      ]\n";
      out << "    }";
      if (++printedCount >= 50) break;
    }
  }
  out << "\n  ]\n";
  out << "}\n";
}

void computeWorldBounds(const std::array<float, 3>& localMin, const std::array<float, 3>& localMax, const gp_Trsf& transform, std::array<float, 3>& worldMin, std::array<float, 3>& worldMax) {
  worldMin = {std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
  worldMax = {std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};

  const std::array<double, 2> xs = {localMin[0], (double)localMax[0]};
  const std::array<double, 2> ys = {localMin[1], (double)localMax[1]};
  const std::array<double, 2> zs = {localMin[2], (double)localMax[2]};

  for (double cx : xs) {
    for (double cy : ys) {
      for (double cz : zs) {
        gp_Pnt p(cx, cy, cz);
        p.Transform(transform);
        worldMin[0] = std::min(worldMin[0], (float)p.X());
        worldMin[1] = std::min(worldMin[1], (float)p.Y());
        worldMin[2] = std::min(worldMin[2], (float)p.Z());
        worldMax[0] = std::max(worldMax[0], (float)p.X());
        worldMax[1] = std::max(worldMax[1], (float)p.Y());
        worldMax[2] = std::max(worldMax[2], (float)p.Z());
      }
    }
  }
}

void validateWorldBounds(const MeshPrimitive& primitive, const TopoDS_Shape& renderShape, const std::string& instancePath) {
  Bnd_Box xcafBox;
  BRepBndLib::Add(renderShape, xcafBox);
  Standard_Real xmin = 0, ymin = 0, zmin = 0, xmax = 0, ymax = 0, zmax = 0;
  if (!xcafBox.IsVoid()) {
    xcafBox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
  }
  double xcafDiag = 0.0;
  if (!xcafBox.IsVoid()) {
    double dx = xmax - xmin;
    double dy = ymax - ymin;
    double dz = zmax - zmin;
    xcafDiag = std::sqrt(dx * dx + dy * dy + dz * dz);
  }

  double glbDiag = 0.0;
  double dx = primitive.worldMax[0] - primitive.worldMin[0];
  double dy = primitive.worldMax[1] - primitive.worldMin[1];
  double dz = primitive.worldMax[2] - primitive.worldMin[2];
  glbDiag = std::sqrt(dx * dx + dy * dy + dz * dz);

  if (xcafDiag > 0.0 && glbDiag > 1.5 * xcafDiag) {
    logLine("[WARNING] GLB world bounding box is wildly larger than XCAF world bounding box for " + instancePath);
    logLine("  - XCAF Bbox: [" + std::to_string(xmin) + "," + std::to_string(ymin) + "," + std::to_string(zmin) + "] to [" + std::to_string(xmax) + "," + std::to_string(ymax) + "," + std::to_string(zmax) + "] (diag: " + std::to_string(xcafDiag) + ")");
    logLine("  - GLB Bbox:  [" + std::to_string(primitive.worldMin[0]) + "," + std::to_string(primitive.worldMin[1]) + "," + std::to_string(primitive.worldMin[2]) + "] to [" + std::to_string(primitive.worldMax[0]) + "," + std::to_string(primitive.worldMax[1]) + "," + std::to_string(primitive.worldMax[2]) + "] (diag: " + std::to_string(glbDiag) + ")");
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3 || argc > 14) {
    std::cerr << "Usage: " << argv[0] << " /path/to/input.step /path/to/output-dir [preview|balanced|high] [--colour-mode experimental|xcaf-baseline] [--colour-space raw|srgb-to-linear] [--parallel-mesh on|off] [--debug-super-coarse-mesh] [--debug-skip-raw-step-styles] [--debug-disable-style-cache]\n";
    return 2;
  }

  const std::string inputPath = argv[1];
  const std::filesystem::path outputDir = argv[2];
  const bool hasQualityArg = argc >= 4 && std::string(argv[3]).rfind("--", 0) != 0;
  const Quality quality = parseQuality(hasQualityArg ? argv[3] : "balanced");
  const CliOptions cliOptions = parseCliOptions(argc, argv, hasQualityArg ? 4 : 3);
  const ColourSpaceConfig colourSpace = cliOptions.colourSpace;
  const ColourModeConfig colourMode = cliOptions.colourMode;
  const auto started = std::chrono::steady_clock::now();

  try {
    std::filesystem::create_directories(outputDir);
    logOut.open(outputDir / "conversion.log");
    if (!logOut) {
      throw std::runtime_error("Could not open conversion.log for writing");
    }

    Profiler profiler(outputDir / "conversion-profile.json");
    Watchdog watchdog;

    logLine("Starting native XCAF STEP to GLB prototype");
    logLine("Input: " + inputPath);
    logLine("Quality: " + quality.name +
            " linearDeflection=" + std::to_string(quality.linearDeflection) +
            " angularDeflection=" + std::to_string(quality.angularDeflection) +
            " relative=" + (quality.relative ? "true" : "false"));
    logLine("Colour space: " + colourSpace.name);
    logLine("Colour mode: " + colourMode.name +
            " applyRawStepStyles=" + (colourMode.applyRawStepStyles ? "true" : "false") +
            " applyLayerColours=" + (colourMode.applyLayerColours ? "true" : "false"));
    logLine("Parallel mesh: " + (cliOptions.parallelMesh ? std::string("on") : std::string("off")));
    logLine("Debug super coarse mesh: " + (cliOptions.debugSuperCoarseMesh ? std::string("true") : std::string("false")));
    logLine("Debug skip raw STEP styles: " + (cliOptions.debugSkipRawStepStyles ? std::string("true") : std::string("false")));
    logLine("Debug disable style cache: " + (cliOptions.debugDisableStyleCache ? std::string("true") : std::string("false")));
    logLine("Debug legacy transform: " + (cliOptions.debugLegacyTransform ? std::string("true") : std::string("false")));
    logLine("Hardware concurrency: " + std::to_string(std::thread::hardware_concurrency()));

    Interface_Static::SetIVal("read.step.assembly.level", 1);

    Handle(TDocStd_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    STEPCAFControl_Reader reader;
    reader.SetNameMode(Standard_True);
    reader.SetColorMode(Standard_True);
    reader.SetLayerMode(Standard_True);
    reader.SetMatMode(Standard_True);

    logLine("STEP read start");
    watchdog.setStage("Reading STEP");
    profiler.startStage("Reading STEP");
    const IFSelect_ReturnStatus status = reader.ReadFile(inputPath.c_str());
    if (status != IFSelect_RetDone) {
      throw std::runtime_error("STEP read failed with status " + std::to_string(static_cast<int>(status)));
    }
    logLine("STEP read end");
    profiler.endStage("Reading STEP", {
      {"status", std::to_string(static_cast<int>(status))},
      {"bytes", std::to_string(std::filesystem::file_size(inputPath))}
    });

    logLine("XCAF doc transfer start");
    watchdog.setStage("Transferring XCAF");
    profiler.startStage("Transferring XCAF");
    if (!reader.Transfer(doc)) {
      throw std::runtime_error("STEP transfer into XCAF document failed");
    }
    logLine("XCAF doc transfer end");
    profiler.endStage("Transferring XCAF");

    Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) colourTool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    Handle(XCAFDoc_LayerTool) layerTool = XCAFDoc_DocumentTool::LayerTool(doc->Main());

    globalDisableStyleCache = cliOptions.debugDisableStyleCache;
    if (!globalDisableStyleCache) {
      logLine("Building shape/subshape color cache start");
      profiler.startStage("Build color cache");
      buildColorCache(colourTool, shapeTool);
      logLine("Building shape/subshape color cache end: cachedCount=" + std::to_string(shapeColorCache.size()));
      profiler.endStage("Build color cache", {{"cached_shapes", std::to_string(shapeColorCache.size())}});
    }

    RawStepStyleResolver rawStepStyles;
    if (!cliOptions.debugSkipRawStepStyles) {
      logLine("Parsing raw STEP presentation styles");
      watchdog.setStage("Parsing STEP styles");
      rawStepStyles.load(inputPath, &profiler);
    }

    TDF_LabelSequence freeShapes;
    shapeTool->GetFreeShapes(freeShapes);

    Stats stats;
    stats.freeShapes = freeShapes.Length();
    stats.rawStepEntities = rawStepStyles.entityCount();
    stats.rawStepStyledItems = rawStepStyles.styledItemCount();
    stats.rawStepColours = rawStepStyles.colourCount();
    stats.rawStepRepresentationColours = rawStepStyles.representationColourCount();
    std::vector<MeshPrimitive> primitives;

    logLine("Free shapes: " + std::to_string(stats.freeShapes));
    logLine("Raw STEP styles: entities=" + std::to_string(stats.rawStepEntities) +
            " styledItems=" + std::to_string(stats.rawStepStyledItems) +
            " colours=" + std::to_string(stats.rawStepColours) +
            " representationColourLinks=" + std::to_string(stats.rawStepRepresentationColours));

    logLine("Recursive topology/body scan start");
    watchdog.setStage("Scanning topology");
    profiler.startStage("Recursive topology/body scan");
    int traversedCompounds = 0, traversedCompsolids = 0, traversedSolids = 0, traversedShells = 0, traversedFaces = 0, traversedEdges = 0, traversedVertices = 0;
    int uniqueCompounds = 0, uniqueCompsolids = 0, uniqueSolids = 0, uniqueShells = 0, uniqueFaces = 0, uniqueEdges = 0, uniqueVertices = 0;
    std::vector<BodyInventoryItem> inventoryItems;

    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
      TDF_Label referred;
      TopoDS_Shape freeShape = shapeForLabel(shapeTool, freeShapes.Value(i), referred);
      if (freeShape.IsNull()) continue;

      int comp = 0, compsol = 0, sol = 0, sh = 0, f = 0, e = 0, v = 0;
      int ucomp = 0, ucompsol = 0, usol = 0, ush = 0, uf = 0, ue = 0, uv = 0;
      scanTopology(freeShape, comp, compsol, sol, sh, f, e, v, ucomp, ucompsol, usol, ush, uf, ue, uv);
      
      traversedCompounds += comp; traversedCompsolids += compsol; traversedSolids += sol; traversedShells += sh; traversedFaces += f; traversedEdges += e; traversedVertices += v;
      uniqueCompounds += ucomp; uniqueCompsolids += ucompsol; uniqueSolids += usol; uniqueShells += ush; uniqueFaces += uf; uniqueEdges += ue; uniqueVertices += uv;

      recursiveInventory(freeShape, shapeTool, colourTool, inventoryItems);
    }
    
    writeBodyInventory(outputDir / "body-inventory.json",
                       traversedCompounds, traversedCompsolids, traversedSolids, traversedShells, traversedFaces, traversedEdges, traversedVertices,
                       uniqueCompounds, uniqueCompsolids, uniqueSolids, uniqueShells, uniqueFaces, uniqueEdges, uniqueVertices,
                       inventoryItems);

    logLine("Recursive topology/body scan end: bodies=" + std::to_string(inventoryItems.size()) +
            " compounds=" + std::to_string(uniqueCompounds) +
            " solids=" + std::to_string(uniqueSolids) +
            " faces=" + std::to_string(uniqueFaces));

    profiler.endStage("Recursive topology/body scan", {
      {"bodies", std::to_string(inventoryItems.size())},
      {"unique_compounds", std::to_string(uniqueCompounds)},
      {"unique_solids", std::to_string(uniqueSolids)},
      {"unique_faces", std::to_string(uniqueFaces)}
    });

    logLine("Recursive XCAF label traversal start");
    watchdog.setStage("Applying styles");
    profiler.startStage("XCAF label traversal");

    // PHASE 1: Collect leaf instances and generate prototype-reuse-report.json
    logLine("Collecting leaf instances for repeated geometry audit...");
    std::vector<LeafInstance> leafInstances;
    Colour noInheritedColour;
    std::vector<LayerInfo> noInheritedLayers;
    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
      collectLeafInstances(
          shapeTool,
          colourTool,
          layerTool,
          &rawStepStyles,
          cliOptions,
          freeShapes.Value(i),
          quality,
          "",
          TopLoc_Location(),
          "label_shape_location",
          false,
          noInheritedColour,
          noInheritedLayers,
          "",
          "",
          "",
          leafInstances);
    }
    logLine("Leaf instances collected: " + std::to_string(leafInstances.size()));

    if (cliOptions.generatePrototypeReport) {
      logLine("Writing prototype-reuse-report.json...");
      writePrototypeReuseReport(outputDir / "prototype-reuse-report.json", leafInstances, shapeTool, colourTool, layerTool, &rawStepStyles, cliOptions, quality);
      logLine("prototype-reuse-report.json written successfully.");
    }
    
    countLeafLabels(shapeTool, freeShapes, totalShapesToMesh);
    logLine("Total leaf shapes to mesh: " + std::to_string(totalShapesToMesh));

    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
      traverse(
          shapeTool,
          colourTool,
          layerTool,
          &rawStepStyles,
          cliOptions,
          freeShapes.Value(i),
          quality,
          "",
          TopLoc_Location(),
          "label_shape_location",
          false,
          noInheritedColour,
          noInheritedLayers,
          "",
          "",
          "",
          primitives,
          stats);
    }

    logLine("Recursive XCAF label traversal end: primitives=" + std::to_string(primitives.size()));
    profiler.endStage("XCAF label traversal", {
      {"primitives", std::to_string(primitives.size())},
      {"labelsProcessed", std::to_string(stats.labelsProcessed)},
      {"shapesTessellated", std::to_string(stats.shapesTessellated)},
      {"styleCacheHits", std::to_string(styleCacheHits)},
      {"styleCacheMisses", std::to_string(styleCacheMisses)},
      {"subshapeCacheHits", std::to_string(subshapeCacheHits)},
      {"subshapeCacheMisses", std::to_string(subshapeCacheMisses)},
      {"shapeColorCacheHits", std::to_string(shapeColorCacheHits)},
      {"shapeColorCacheMisses", std::to_string(shapeColorCacheMisses)},
      {"labelColorCacheHits", std::to_string(labelColorCacheHits)},
      {"labelColorCacheMisses", std::to_string(labelColorCacheMisses)},
      {"styledFaces", std::to_string(styledFacesCount)},
      {"fallbackColors", std::to_string(fallbackColorsCount)}
    });

    if (primitives.empty()) {
      throw std::runtime_error("No renderable triangulated primitives were produced");
    }

    logLine("Cache statistics: styledFaceCacheHits=" + std::to_string(styleCacheHits) +
            " styledFaceCacheMisses=" + std::to_string(styleCacheMisses) +
            " subshapeCacheHits=" + std::to_string(subshapeCacheHits) +
            " subshapeCacheMisses=" + std::to_string(subshapeCacheMisses) +
            " shapeColorCacheHits=" + std::to_string(shapeColorCacheHits) +
            " shapeColorCacheMisses=" + std::to_string(shapeColorCacheMisses) +
            " labelColorCacheHits=" + std::to_string(labelColorCacheHits) +
            " labelColorCacheMisses=" + std::to_string(labelColorCacheMisses));
    logLine("Color mapping statistics: styledFaces=" + std::to_string(styledFacesCount) +
            " fallbackColors=" + std::to_string(fallbackColorsCount));

    logLine("Writing display.glb");
    watchdog.setStage("Writing GLB");
    const auto glbPath = outputDir / "display.glb";
    writeGlb(glbPath, primitives, colourSpace, &profiler);

    const auto finished = std::chrono::steady_clock::now();
    stats.conversionSeconds = std::chrono::duration<double>(finished - started).count();
    const auto glbSize = std::filesystem::file_size(glbPath);

    logLine("Writing xcaf-report.json");
    writeReport(outputDir / "xcaf-report.json", inputPath, quality, colourSpace, colourMode, stats, rawStepStyles.colourAudit(), primitives, glbSize);

    logLine("Writing material-style-profile.json");
    writeMaterialStyleProfile(outputDir / "material-style-profile.json", rawStepStyles, stats);

    logLine("Mesh reuse statistics: reusedInstances=" + std::to_string(stats.reusedInstances) +
            " freshInstances=" + std::to_string(stats.freshInstances) +
            " cacheHits=" + std::to_string(stats.tessellationCacheHits) +
            " cacheMisses=" + std::to_string(stats.tessellationCacheMisses) +
            " uniqueStoredTriangles=" + std::to_string(stats.uniqueStoredTriangles) +
            " totalRenderedTriangles=" + std::to_string(stats.triangles));

    logLine("Done: primitives=" + std::to_string(stats.primitivesExported) +
            " triangles=" + std::to_string(stats.triangles) +
            " glbBytes=" + std::to_string(glbSize));
  } catch (const Standard_Failure& failure) {
    std::cerr << "OpenCascade failure: " << failure.GetMessageString() << "\n";
    if (logOut) logLine(std::string("OpenCascade failure: ") + failure.GetMessageString());
    return 1;
  } catch (const std::exception& ex) {
    std::cerr << "Error: " << ex.what() << "\n";
    if (logOut) logLine(std::string("Error: ") + ex.what());
    return 1;
  }

  return 0;
}
