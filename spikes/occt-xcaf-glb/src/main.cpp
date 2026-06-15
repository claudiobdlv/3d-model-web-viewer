#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
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
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Colour {
  double r = 0.62;
  double g = 0.64;
  double b = 0.66;
  double a = 1.0;
  std::string source = "default_neutral_grey";
};

struct Quality {
  std::string name = "balanced";
  double linearDeflection = 0.35;
  double angularDeflection = 0.45;
  bool relative = true;
};

struct MeshPrimitive {
  std::string name;
  std::string labelPath;
  std::string displayName;
  std::string layer;
  std::string colourSource;
  std::string originalStepLabel;
  std::string stableObjectId;
  Colour colour;
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<std::uint32_t> indices;
  std::array<float, 3> min = {
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max(),
      std::numeric_limits<float>::max()};
  std::array<float, 3> max = {
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest(),
      std::numeric_limits<float>::lowest()};
};

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
  double conversionSeconds = 0.0;
  std::map<std::string, int> coloursBySource;
  std::set<std::string> uniqueColours;
  std::set<std::string> layers;
};

std::ofstream logOut;

void logLine(const std::string& message) {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  logOut << std::put_time(std::localtime(&now), "%F %T") << " " << message << "\n";
  logOut.flush();
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

std::string safeName(const std::string& value, const std::string& fallback) {
  return value.empty() ? fallback : value;
}

std::string colourKey(const Colour& colour) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6)
      << colour.r << "," << colour.g << "," << colour.b << "," << colour.a;
  return out.str();
}

bool readLabelColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label,
    const XCAFDoc_ColorType type,
    const std::string& source,
    Colour& colour) {
  Quantity_ColorRGBA rgba;
  if (colourTool->GetColor(label, type, rgba)) {
    colour.r = rgba.GetRGB().Red();
    colour.g = rgba.GetRGB().Green();
    colour.b = rgba.GetRGB().Blue();
    colour.a = rgba.Alpha();
    colour.source = source;
    return true;
  }

  Quantity_Color rgb;
  if (colourTool->GetColor(label, type, rgb)) {
    colour.r = rgb.Red();
    colour.g = rgb.Green();
    colour.b = rgb.Blue();
    colour.a = 1.0;
    colour.source = source;
    return true;
  }

  return false;
}

bool readShapeColour(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TopoDS_Shape& shape,
    const XCAFDoc_ColorType type,
    const std::string& source,
    Colour& colour) {
  Quantity_ColorRGBA rgba;
  if (colourTool->GetColor(shape, type, rgba)) {
    colour.r = rgba.GetRGB().Red();
    colour.g = rgba.GetRGB().Green();
    colour.b = rgba.GetRGB().Blue();
    colour.a = rgba.Alpha();
    colour.source = source;
    return true;
  }

  Quantity_Color rgb;
  if (colourTool->GetColor(shape, type, rgb)) {
    colour.r = rgb.Red();
    colour.g = rgb.Green();
    colour.b = rgb.Blue();
    colour.a = 1.0;
    colour.source = source;
    return true;
  }

  return false;
}

bool firstColourForLabel(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TDF_Label& label,
    const std::string& prefix,
    Colour& colour) {
  for (const auto& item : std::vector<std::pair<XCAFDoc_ColorType, std::string>>{
           {XCAFDoc_ColorSurf, "surface"},
           {XCAFDoc_ColorGen, "generic"},
           {XCAFDoc_ColorCurv, "curve"}}) {
    if (readLabelColour(colourTool, label, item.first, prefix + item.second, colour)) {
      return true;
    }
  }
  return false;
}

bool firstColourForShape(
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const TopoDS_Shape& shape,
    const std::string& prefix,
    Colour& colour) {
  for (const auto& item : std::vector<std::pair<XCAFDoc_ColorType, std::string>>{
           {XCAFDoc_ColorSurf, "surface"},
           {XCAFDoc_ColorGen, "generic"},
           {XCAFDoc_ColorCurv, "curve"}}) {
    if (readShapeColour(colourTool, shape, item.first, prefix + item.second, colour)) {
      return true;
    }
  }
  return false;
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

std::string firstLayer(
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& label,
    const TDF_Label& referred) {
  auto layers = collectLayers(layerTool, label);
  if (layers.empty() && !referred.IsNull()) {
    layers = collectLayers(layerTool, referred);
  }
  return layers.empty() ? "" : layers.front();
}

Quality parseQuality(const std::string& value) {
  if (value == "high") {
    return {"high", 0.12, 0.22, true};
  }
  if (value == "balanced") {
    return {"balanced", 0.35, 0.45, true};
  }
  throw std::runtime_error("Unsupported quality preset: " + value);
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

void tessellateLabel(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& label,
    const Quality& quality,
    const bool hasInheritedColour,
    const Colour& inheritedColour,
    std::vector<MeshPrimitive>& primitives,
    Stats& stats) {
  stats.labelsProcessed += 1;
  TDF_Label referred;
  TopoDS_Shape shape = shapeForLabel(shapeTool, label, referred);
  if (shape.IsNull()) {
    stats.skippedShapes += 1;
    return;
  }

  const std::string labelPath = labelEntry(label);
  const std::string referredPath = referred.IsNull() ? "" : labelEntry(referred);
  const std::string displayName = safeName(labelName(label), safeName(referred.IsNull() ? "" : labelName(referred), labelPath));
  if (!displayName.empty() && displayName != labelPath) {
    stats.namedObjects += 1;
  }
  const std::string layer = firstLayer(layerTool, label, referred);
  if (!layer.empty()) {
    stats.layers.insert(layer);
  }

  Colour labelColour;
  bool labelHasColour = firstColourForLabel(colourTool, label, "label_", labelColour);
  if (!labelHasColour && !referred.IsNull()) {
    labelHasColour = firstColourForLabel(colourTool, referred, "referred_label_", labelColour);
  }
  if (!labelHasColour && hasInheritedColour) {
    labelColour = inheritedColour;
    labelColour.source = "inherited_" + inheritedColour.source;
    labelHasColour = true;
  }
  if (labelHasColour) {
    stats.labelsWithColour += 1;
  }

  try {
    BRepMesh_IncrementalMesh mesh(shape, quality.linearDeflection, quality.relative, quality.angularDeflection, Standard_True);
    mesh.Perform();
    stats.shapesTessellated += 1;
  } catch (const Standard_Failure& failure) {
    logLine("Tessellation failed for " + labelPath + ": " + failure.GetMessageString());
    stats.failedShapes += 1;
    return;
  }

  int faceIndex = 0;
  for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
    const TopoDS_Face face = TopoDS::Face(explorer.Current());
    TopLoc_Location loc;
    if (BRep_Tool::Triangulation(face, loc).IsNull()) {
      continue;
    }

    Colour colour = labelColour;
    bool hasColour = labelHasColour;
    Colour faceColour;
    if (firstColourForShape(colourTool, face, "face_", faceColour)) {
      colour = faceColour;
      hasColour = true;
    }

    if (!hasColour) {
      stats.defaultMaterialUses += 1;
    }

    MeshPrimitive primitive;
    primitive.name = displayName + " face " + std::to_string(faceIndex);
    primitive.labelPath = labelPath;
    primitive.displayName = displayName;
    primitive.layer = layer;
    primitive.colourSource = colour.source;
    primitive.originalStepLabel = referredPath.empty() ? labelPath : referredPath;
    primitive.stableObjectId = labelPath + "/face/" + std::to_string(faceIndex);
    primitive.colour = colour;
    appendFaceTriangles(primitive, face);

    if (!primitive.indices.empty()) {
      stats.vertices += primitive.positions.size() / 3;
      stats.triangles += primitive.indices.size() / 3;
      stats.primitivesExported += 1;
      stats.coloursBySource[colour.source] += 1;
      stats.uniqueColours.insert(colourKey(colour));
      primitives.push_back(std::move(primitive));
    }
    faceIndex += 1;
  }
}

void traverse(
    const Handle(XCAFDoc_ShapeTool)& shapeTool,
    const Handle(XCAFDoc_ColorTool)& colourTool,
    const Handle(XCAFDoc_LayerTool)& layerTool,
    const TDF_Label& label,
    const Quality& quality,
    const bool hasInheritedColour,
    const Colour& inheritedColour,
    std::vector<MeshPrimitive>& primitives,
    Stats& stats) {
  TDF_LabelSequence children;
  bool hasChildren = shapeTool->GetComponents(label, children, Standard_False);
  if (!hasChildren && shapeTool->IsReference(label)) {
    TDF_Label referred;
    if (shapeTool->GetReferredShape(label, referred)) {
      hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
    }
  }

  if (hasChildren && children.Length() > 0) {
    stats.labelsProcessed += 1;
    const std::string name = labelName(label);
    if (!name.empty()) {
      stats.namedObjects += 1;
    }
    Colour childInherited = inheritedColour;
    bool childHasInherited = hasInheritedColour;
    if (firstColourForLabel(colourTool, label, "label_", childInherited)) {
      childHasInherited = true;
      stats.labelsWithColour += 1;
    } else if (shapeTool->IsReference(label)) {
      TDF_Label referred;
      if (shapeTool->GetReferredShape(label, referred) &&
          firstColourForLabel(colourTool, referred, "referred_label_", childInherited)) {
        childHasInherited = true;
        stats.labelsWithColour += 1;
      }
    }
    for (Standard_Integer i = 1; i <= children.Length(); ++i) {
      traverse(shapeTool, colourTool, layerTool, children.Value(i), quality, childHasInherited, childInherited, primitives, stats);
    }
    return;
  }

  tessellateLabel(shapeTool, colourTool, layerTool, label, quality, hasInheritedColour, inheritedColour, primitives, stats);
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

void writeGlb(const std::filesystem::path& outputPath, const std::vector<MeshPrimitive>& primitives) {
  std::vector<std::uint8_t> bin;
  std::vector<BufferViewInfo> views;
  std::vector<AccessorInfo> accessors;

  struct MeshRefs {
    int positionAccessor = 0;
    int normalAccessor = 0;
    int indexAccessor = 0;
    int material = 0;
  };
  std::vector<MeshRefs> refs;
  refs.reserve(primitives.size());

  std::map<std::string, int> materialByColour;
  std::vector<Colour> materials;

  for (const auto& primitive : primitives) {
    const std::string key = colourKey(primitive.colour);
    int materialIndex = 0;
    const auto found = materialByColour.find(key);
    if (found == materialByColour.end()) {
      materialIndex = static_cast<int>(materials.size());
      materialByColour[key] = materialIndex;
      materials.push_back(primitive.colour);
    } else {
      materialIndex = found->second;
    }

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
    refs.push_back(meshRefs);
  }
  alignBuffer(bin);

  std::ostringstream json;
  json << std::fixed << std::setprecision(6);
  json << "{";
  json << "\"asset\":{\"version\":\"2.0\",\"generator\":\"occt-xcaf-glb-spike\"},";
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
    json << ",\"mesh\":" << i << ",\"extras\":{";
    json << "\"stableObjectId\":"; writeString(json, primitive.stableObjectId); json << ",";
    json << "\"labelPath\":"; writeString(json, primitive.labelPath); json << ",";
    json << "\"displayName\":"; writeString(json, primitive.displayName); json << ",";
    json << "\"layer\":"; writeString(json, primitive.layer); json << ",";
    json << "\"colourSource\":"; writeString(json, primitive.colourSource); json << ",";
    json << "\"originalStepLabel\":"; writeString(json, primitive.originalStepLabel);
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
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    if (i > 0) json << ",";
    json << "{\"name\":";
    writeString(json, primitives[i].name);
    json << ",\"primitives\":[{\"attributes\":{\"POSITION\":" << refs[i].positionAccessor
         << ",\"NORMAL\":" << refs[i].normalAccessor
         << "},\"indices\":" << refs[i].indexAccessor
         << ",\"material\":" << refs[i].material
         << ",\"mode\":4}]}";
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
}

void writeReport(
    const std::filesystem::path& outputPath,
    const std::string& inputPath,
    const Quality& quality,
    const Stats& stats,
    const std::vector<MeshPrimitive>& primitives,
    const std::uintmax_t glbSize) {
  std::ofstream out(outputPath);
  if (!out) {
    throw std::runtime_error("Could not open report path for writing: " + outputPath.string());
  }

  out << std::fixed << std::setprecision(6);
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
  out << "  \"colourPriority\": [\"face_surface\", \"face_generic\", \"face_curve\", \"label_surface\", \"label_generic\", \"label_curve\", \"referred_label_surface\", \"referred_label_generic\", \"referred_label_curve\", \"default_neutral_grey\"],\n";
  out << "  \"summary\": {\n";
  out << "    \"freeShapes\": " << stats.freeShapes << ",\n";
  out << "    \"labelsComponentsProcessed\": " << stats.labelsProcessed << ",\n";
  out << "    \"namedObjects\": " << stats.namedObjects << ",\n";
  out << "    \"colouredObjects\": " << stats.labelsWithColour << ",\n";
  out << "    \"uniqueColours\": " << stats.uniqueColours.size() << ",\n";
  out << "    \"layers\": " << stats.layers.size() << ",\n";
  out << "    \"shapesTessellated\": " << stats.shapesTessellated << ",\n";
  out << "    \"meshesPrimitivesExported\": " << stats.primitivesExported << ",\n";
  out << "    \"vertices\": " << stats.vertices << ",\n";
  out << "    \"triangles\": " << stats.triangles << ",\n";
  out << "    \"skippedShapes\": " << stats.skippedShapes << ",\n";
  out << "    \"failedShapes\": " << stats.failedShapes << ",\n";
  out << "    \"defaultMaterialUsage\": " << stats.defaultMaterialUses << ",\n";
  out << "    \"glbBytes\": " << glbSize << ",\n";
  out << "    \"conversionSeconds\": " << stats.conversionSeconds << "\n";
  out << "  },\n";
  out << "  \"coloursBySource\": {";
  bool first = true;
  for (const auto& item : stats.coloursBySource) {
    if (!first) out << ", ";
    first = false;
    writeString(out, item.first);
    out << ": " << item.second;
  }
  out << "},\n";
  out << "  \"uniqueColourValues\": [";
  first = true;
  for (const auto& item : stats.uniqueColours) {
    if (!first) out << ", ";
    first = false;
    writeString(out, item);
  }
  out << "],\n";
  out << "  \"layers\": [";
  first = true;
  for (const auto& layer : stats.layers) {
    if (!first) out << ", ";
    first = false;
    writeString(out, layer);
  }
  out << "],\n";
  out << "  \"objects\": [\n";
  for (std::size_t i = 0; i < primitives.size(); ++i) {
    const auto& primitive = primitives[i];
    out << "    {";
    out << "\"stableObjectId\": "; writeString(out, primitive.stableObjectId); out << ", ";
    out << "\"labelPath\": "; writeString(out, primitive.labelPath); out << ", ";
    out << "\"displayName\": "; writeString(out, primitive.displayName); out << ", ";
    out << "\"layer\": "; writeString(out, primitive.layer); out << ", ";
    out << "\"colourSource\": "; writeString(out, primitive.colourSource); out << ", ";
    out << "\"triangles\": " << (primitive.indices.size() / 3);
    out << "}" << (i + 1 < primitives.size() ? "," : "") << "\n";
  }
  out << "  ],\n";
  out << "  \"limitations\": [\n";
  out << "    \"Prototype writes one GLB node per tessellated face to preserve sharp CAD normals and face colour identity; this is verbose for large assemblies.\",\n";
  out << "    \"Assembly hierarchy is flattened to renderable nodes; label paths and stableObjectId are preserved in node extras for later selection work.\",\n";
  out << "    \"Material rules are not used; uncoloured geometry receives a neutral grey fallback.\"\n";
  out << "  ]\n";
  out << "}\n";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3 || argc > 4) {
    std::cerr << "Usage: " << argv[0] << " /path/to/input.step /path/to/output-dir [balanced|high]\n";
    return 2;
  }

  const std::string inputPath = argv[1];
  const std::filesystem::path outputDir = argv[2];
  const Quality quality = parseQuality(argc == 4 ? argv[3] : "balanced");
  const auto started = std::chrono::steady_clock::now();

  try {
    std::filesystem::create_directories(outputDir);
    logOut.open(outputDir / "conversion.log");
    if (!logOut) {
      throw std::runtime_error("Could not open conversion.log for writing");
    }

    logLine("Starting native XCAF STEP to GLB prototype");
    logLine("Input: " + inputPath);
    logLine("Quality: " + quality.name +
            " linearDeflection=" + std::to_string(quality.linearDeflection) +
            " angularDeflection=" + std::to_string(quality.angularDeflection) +
            " relative=" + (quality.relative ? "true" : "false"));

    Interface_Static::SetIVal("read.step.assembly.level", 1);

    Handle(TDocStd_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    STEPCAFControl_Reader reader;
    reader.SetNameMode(Standard_True);
    reader.SetColorMode(Standard_True);
    reader.SetLayerMode(Standard_True);
    reader.SetMatMode(Standard_True);

    logLine("Reading STEP with STEPCAFControl_Reader");
    const IFSelect_ReturnStatus status = reader.ReadFile(inputPath.c_str());
    if (status != IFSelect_RetDone) {
      throw std::runtime_error("STEP read failed with status " + std::to_string(static_cast<int>(status)));
    }

    logLine("Transferring STEP into XCAF document");
    if (!reader.Transfer(doc)) {
      throw std::runtime_error("STEP transfer into XCAF document failed");
    }

    Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) colourTool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    Handle(XCAFDoc_LayerTool) layerTool = XCAFDoc_DocumentTool::LayerTool(doc->Main());

    TDF_LabelSequence freeShapes;
    shapeTool->GetFreeShapes(freeShapes);

    Stats stats;
    stats.freeShapes = freeShapes.Length();
    std::vector<MeshPrimitive> primitives;

    logLine("Free shapes: " + std::to_string(stats.freeShapes));
    Colour noInheritedColour;
    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
      traverse(shapeTool, colourTool, layerTool, freeShapes.Value(i), quality, false, noInheritedColour, primitives, stats);
    }

    if (primitives.empty()) {
      throw std::runtime_error("No renderable triangulated primitives were produced");
    }

    logLine("Writing display.glb");
    const auto glbPath = outputDir / "display.glb";
    writeGlb(glbPath, primitives);

    const auto finished = std::chrono::steady_clock::now();
    stats.conversionSeconds = std::chrono::duration<double>(finished - started).count();
    const auto glbSize = std::filesystem::file_size(glbPath);

    logLine("Writing xcaf-report.json");
    writeReport(outputDir / "xcaf-report.json", inputPath, quality, stats, primitives, glbSize);
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
