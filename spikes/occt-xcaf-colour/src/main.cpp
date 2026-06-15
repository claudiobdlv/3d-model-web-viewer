#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Quantity_ColorRGBA.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <Standard_Version.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_AttributeIterator.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TDocStd_Application.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_LayerTool.hxx>
#include <XCAFDoc_MaterialTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>

#include <algorithm>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct ColourHit {
  std::string source;
  double r = 0.0;
  double g = 0.0;
  double b = 0.0;
  double a = 1.0;
};

struct NodeReport {
  std::string labelPath;
  std::string name;
  std::string kind;
  std::string shapeType;
  std::string referredLabel;
  bool isAssembly = false;
  bool isComponent = false;
  bool isReference = false;
  int childCount = 0;
  std::vector<ColourHit> colours;
  std::vector<std::string> layers;
  std::vector<std::string> materials;
};

struct Summary {
  int labelsWithNames = 0;
  int labelsWithColours = 0;
  int unnamedLabels = 0;
  int uncolouredLabels = 0;
  std::map<std::string, int> coloursBySource;
  std::set<std::string> uniqueColours;
  std::set<std::string> layersFound;
  std::set<std::string> materialsFound;
};

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

std::string labelEntry(const TDF_Label& label) {
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return entry.ToCString();
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

std::string colourKey(const ColourHit& colour) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6)
      << colour.r << "," << colour.g << "," << colour.b << "," << colour.a;
  return out.str();
}

bool readColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label,
    const XCAFDoc_ColorType type,
    const std::string& source,
    ColourHit& hit) {
  Quantity_ColorRGBA rgba;
  if (colourTool->GetColor(label, type, rgba)) {
    hit.source = source;
    hit.r = rgba.GetRGB().Red();
    hit.g = rgba.GetRGB().Green();
    hit.b = rgba.GetRGB().Blue();
    hit.a = rgba.Alpha();
    return true;
  }

  Quantity_Color rgb;
  if (colourTool->GetColor(label, type, rgb)) {
    hit.source = source;
    hit.r = rgb.Red();
    hit.g = rgb.Green();
    hit.b = rgb.Blue();
    hit.a = 1.0;
    return true;
  }

  return false;
}

std::vector<ColourHit> collectColours(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label) {
  std::vector<ColourHit> hits;
  for (const auto& item : std::vector<std::pair<XCAFDoc_ColorType, std::string>>{
           {XCAFDoc_ColorGen, "generic"},
           {XCAFDoc_ColorSurf, "surface"},
           {XCAFDoc_ColorCurv, "curve"}}) {
    ColourHit hit;
    if (readColour(colourTool, label, item.first, item.second, hit)) {
      hits.push_back(hit);
    }
  }
  return hits;
}

std::vector<std::string> collectLayers(
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& label) {
  std::vector<std::string> layers;
  TDF_LabelSequence layerLabels;
  layerTool->GetLayers(label, layerLabels);
  for (Standard_Integer i = 1; i <= layerLabels.Length(); ++i) {
    const std::string name = labelName(layerLabels.Value(i));
    layers.push_back(name.empty() ? labelEntry(layerLabels.Value(i)) : name);
  }
  std::sort(layers.begin(), layers.end());
  layers.erase(std::unique(layers.begin(), layers.end()), layers.end());
  return layers;
}

std::vector<std::string> collectMaterialHints(const TDF_Label& label) {
  std::vector<std::string> materials;
  for (TDF_AttributeIterator it(label); it.More(); it.Next()) {
    const Handle(Standard_Type)& attrType = it.Value()->DynamicType();
    const std::string typeName = attrType->Name();
    if (typeName.find("Material") != std::string::npos &&
        typeName != "XCAFDoc_MaterialTool") {
      materials.push_back(typeName);
    }
  }
  std::sort(materials.begin(), materials.end());
  materials.erase(std::unique(materials.begin(), materials.end()), materials.end());
  return materials;
}

void updateSummary(const NodeReport& node, Summary& summary) {
  if (node.name.empty()) {
    summary.unnamedLabels += 1;
  } else {
    summary.labelsWithNames += 1;
  }

  if (node.colours.empty()) {
    summary.uncolouredLabels += 1;
  } else {
    summary.labelsWithColours += 1;
  }

  for (const auto& colour : node.colours) {
    summary.coloursBySource[colour.source] += 1;
    summary.uniqueColours.insert(colourKey(colour));
  }
  for (const auto& layer : node.layers) {
    summary.layersFound.insert(layer);
  }
  for (const auto& material : node.materials) {
    summary.materialsFound.insert(material);
  }
}

NodeReport makeNodeReport(
    const TDF_Label& label,
    const std::string& kind,
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool) {
  NodeReport node;
  node.labelPath = labelEntry(label);
  node.name = labelName(label);
  node.kind = kind;
  node.isAssembly = shapeTool->IsAssembly(label);
  node.isComponent = shapeTool->IsComponent(label);
  node.isReference = shapeTool->IsReference(label);

  TDF_Label referred;
  if (node.isReference && shapeTool->GetReferredShape(label, referred)) {
    node.referredLabel = labelEntry(referred);
    if (node.name.empty()) {
      node.name = labelName(referred);
    }
  }

  TopoDS_Shape shape;
  if (shapeTool->GetShape(label, shape) && !shape.IsNull()) {
    node.shapeType = shapeTypeName(shape.ShapeType());
  }

  TDF_LabelSequence children;
  if (shapeTool->GetComponents(label, children, Standard_False)) {
    node.childCount = children.Length();
  } else if (!node.referredLabel.empty()) {
    TDF_Label referredLabel;
    shapeTool->GetReferredShape(label, referredLabel);
    if (shapeTool->GetComponents(referredLabel, children, Standard_False)) {
      node.childCount = children.Length();
    }
  }

  node.colours = collectColours(colourTool, label);
  if (node.colours.empty() && !node.referredLabel.empty()) {
    TDF_Label referredLabel;
    if (shapeTool->GetReferredShape(label, referredLabel)) {
      node.colours = collectColours(colourTool, referredLabel);
    }
  }

  node.layers = collectLayers(layerTool, label);
  node.materials = collectMaterialHints(label);
  return node;
}

void appendChildren(
    const TDF_Label& label,
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    TDF_LabelSequence& children) {
  if (shapeTool->GetComponents(label, children, Standard_False)) {
    return;
  }

  TDF_Label referred;
  if (shapeTool->IsReference(label) && shapeTool->GetReferredShape(label, referred)) {
    shapeTool->GetComponents(referred, children, Standard_False);
  }
}

void traverseAssembly(
    const TDF_Label& label,
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    std::set<std::string>& visited,
    std::vector<NodeReport>& nodes,
    Summary& summary) {
  const std::string key = labelEntry(label);
  if (!visited.insert(key).second) {
    return;
  }

  NodeReport node = makeNodeReport(label, "assembly_label", shapeTool, colourTool, layerTool);
  updateSummary(node, summary);
  nodes.push_back(node);

  TDF_LabelSequence children;
  appendChildren(label, shapeTool, children);
  for (Standard_Integer i = 1; i <= children.Length(); ++i) {
    traverseAssembly(children.Value(i), shapeTool, colourTool, layerTool, visited, nodes, summary);
  }
}

void collectSubshapeLabels(
    const TDF_Label& root,
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    std::set<std::string>& visited,
    std::vector<NodeReport>& nodes,
    Summary& summary) {
  for (TDF_ChildIterator it(root, Standard_True); it.More(); it.Next()) {
    const TDF_Label child = it.Value();
    const std::string key = labelEntry(child);
    if (visited.find(key) != visited.end()) {
      continue;
    }
    const auto colours = collectColours(colourTool, child);
    const auto layers = collectLayers(layerTool, child);
    const auto materials = collectMaterialHints(child);
    if (!shapeTool->IsShape(child) && colours.empty() && layers.empty() && materials.empty()) {
      continue;
    }
    visited.insert(key);
    NodeReport node = makeNodeReport(child, "label_or_subshape", shapeTool, colourTool, layerTool);
    updateSummary(node, summary);
    nodes.push_back(node);
  }
}

void writeStringArray(std::ostream& out, const std::vector<std::string>& values) {
  out << "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i > 0) {
      out << ", ";
    }
    writeString(out, values[i]);
  }
  out << "]";
}

void writeSetArray(std::ostream& out, const std::set<std::string>& values) {
  out << "[";
  bool first = true;
  for (const auto& value : values) {
    if (!first) {
      out << ", ";
    }
    first = false;
    writeString(out, value);
  }
  out << "]";
}

void writeReport(
    const std::string& inputPath,
    const bool readOk,
    const std::string& status,
    const int freeShapeCount,
    const std::vector<NodeReport>& nodes,
    const Summary& summary,
    const std::string& outputPath) {
  std::ofstream out(outputPath);
  if (!out) {
    throw std::runtime_error("Could not open report path for writing: " + outputPath);
  }

  out << std::fixed << std::setprecision(6);
  out << "{\n";
  out << "  \"inputFile\": "; writeString(out, inputPath); out << ",\n";
  out << "  \"openCascadeVersion\": "; writeString(out, OCC_VERSION_COMPLETE); out << ",\n";
  out << "  \"readSuccess\": " << (readOk ? "true" : "false") << ",\n";
  out << "  \"status\": "; writeString(out, status); out << ",\n";
  out << "  \"freeShapeCount\": " << freeShapeCount << ",\n";
  out << "  \"labelComponentCount\": " << nodes.size() << ",\n";
  out << "  \"summary\": {\n";
  out << "    \"labelsWithNames\": " << summary.labelsWithNames << ",\n";
  out << "    \"labelsWithColours\": " << summary.labelsWithColours << ",\n";
  out << "    \"coloursBySource\": {";
  bool firstSource = true;
  for (const auto& item : summary.coloursBySource) {
    if (!firstSource) {
      out << ", ";
    }
    firstSource = false;
    writeString(out, item.first);
    out << ": " << item.second;
  }
  out << "},\n";
  out << "    \"uniqueColours\": "; writeSetArray(out, summary.uniqueColours); out << ",\n";
  out << "    \"layersFound\": "; writeSetArray(out, summary.layersFound); out << ",\n";
  out << "    \"materialsFound\": "; writeSetArray(out, summary.materialsFound); out << ",\n";
  out << "    \"unnamedLabels\": " << summary.unnamedLabels << ",\n";
  out << "    \"uncolouredLabels\": " << summary.uncolouredLabels << "\n";
  out << "  },\n";
  out << "  \"assemblyTree\": [\n";
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const auto& node = nodes[i];
    out << "    {\n";
    out << "      \"labelPath\": "; writeString(out, node.labelPath); out << ",\n";
    out << "      \"kind\": "; writeString(out, node.kind); out << ",\n";
    out << "      \"displayName\": "; writeString(out, node.name); out << ",\n";
    out << "      \"shapeType\": "; writeString(out, node.shapeType); out << ",\n";
    out << "      \"isAssembly\": " << (node.isAssembly ? "true" : "false") << ",\n";
    out << "      \"isComponent\": " << (node.isComponent ? "true" : "false") << ",\n";
    out << "      \"isReference\": " << (node.isReference ? "true" : "false") << ",\n";
    out << "      \"referredLabel\": "; writeString(out, node.referredLabel); out << ",\n";
    out << "      \"hasColour\": " << (!node.colours.empty() ? "true" : "false") << ",\n";
    out << "      \"colours\": [";
    for (std::size_t c = 0; c < node.colours.size(); ++c) {
      const auto& colour = node.colours[c];
      if (c > 0) {
        out << ", ";
      }
      out << "{\"source\": ";
      writeString(out, colour.source);
      out << ", \"r\": " << colour.r
          << ", \"g\": " << colour.g
          << ", \"b\": " << colour.b
          << ", \"a\": " << colour.a << "}";
    }
    out << "],\n";
    out << "      \"layers\": "; writeStringArray(out, node.layers); out << ",\n";
    out << "      \"materials\": "; writeStringArray(out, node.materials); out << ",\n";
    out << "      \"childCount\": " << node.childCount << "\n";
    out << "    }" << (i + 1 < nodes.size() ? "," : "") << "\n";
  }
  out << "  ]\n";
  out << "}\n";
}

std::string statusName(const IFSelect_ReturnStatus status) {
  switch (status) {
    case IFSelect_RetVoid: return "void";
    case IFSelect_RetDone: return "done";
    case IFSelect_RetError: return "error";
    case IFSelect_RetFail: return "fail";
    case IFSelect_RetStop: return "stop";
  }
  return "unknown";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "Usage: " << argv[0] << " /path/to/input.step /path/to/report.json\n";
    return 2;
  }

  const std::string inputPath = argv[1];
  const std::string outputPath = argv[2];

  try {
    Interface_Static::SetIVal("read.step.assembly.level", 1);

    Handle(TDocStd_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    STEPCAFControl_Reader reader;
    reader.SetNameMode(Standard_True);
    reader.SetColorMode(Standard_True);
    reader.SetLayerMode(Standard_True);
    reader.SetMatMode(Standard_True);

    const IFSelect_ReturnStatus status = reader.ReadFile(inputPath.c_str());
    bool readOk = status == IFSelect_RetDone;
    if (readOk) {
      readOk = reader.Transfer(doc);
    }

    Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) colourTool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    Handle(XCAFDoc_LayerTool) layerTool = XCAFDoc_DocumentTool::LayerTool(doc->Main());
    XCAFDoc_DocumentTool::MaterialTool(doc->Main());

    TDF_LabelSequence freeShapes;
    if (readOk) {
      shapeTool->GetFreeShapes(freeShapes);
    }

    std::vector<NodeReport> nodes;
    Summary summary;
    std::set<std::string> visited;

    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
      traverseAssembly(freeShapes.Value(i), shapeTool, colourTool, layerTool, visited, nodes, summary);
    }

    if (readOk) {
      collectSubshapeLabels(doc->Main(), shapeTool, colourTool, layerTool, visited, nodes, summary);
    }

    writeReport(
        inputPath,
        readOk,
        statusName(status),
        freeShapes.Length(),
        nodes,
        summary,
        outputPath);
  } catch (const Standard_Failure& failure) {
    std::cerr << "OpenCascade failure: " << failure.GetMessageString() << "\n";
    return 1;
  } catch (const std::exception& ex) {
    std::cerr << "Error: " << ex.what() << "\n";
    return 1;
  }

  return 0;
}
