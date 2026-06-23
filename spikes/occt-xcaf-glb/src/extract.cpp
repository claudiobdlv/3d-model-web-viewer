#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_LayerTool.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Compound.hxx>
#include <BRep_Builder.hxx>
#include <Interface_Static.hxx>
#include <iostream>
#include <string>
#include <vector>
#include <set>
#include <map>
#include <filesystem>
#include <algorithm>

// Helpers from main.cpp
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

// Recursive leaf counter
int countLeafs(const Handle(XCAFDoc_ShapeTool)& shapeTool, const TDF_Label& label) {
  TDF_LabelSequence children;
  bool hasChildren = shapeTool->GetComponents(label, children, Standard_False);
  if (!hasChildren && shapeTool->IsReference(label)) {
    TDF_Label referred;
    if (shapeTool->GetReferredShape(label, referred)) {
      hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
    }
  }
  if (hasChildren && children.Length() > 0) {
    int count = 0;
    for (Standard_Integer i = 1; i <= children.Length(); ++i) {
      count += countLeafs(shapeTool, children.Value(i));
    }
    return count;
  }
  return 1;
}

// Collect all assembly labels and their leaf counts
void collectAssemblies(const Handle(XCAFDoc_ShapeTool)& shapeTool, const TDF_Label& label, std::vector<std::pair<TDF_Label, int>>& assemblies, std::set<std::string>& visited) {
  std::string entry = labelEntry(label);
  if (visited.count(entry)) return;
  visited.insert(entry);

  TDF_LabelSequence children;
  bool isAssembly = shapeTool->GetComponents(label, children, Standard_False);
  TDF_Label referred = label;
  if (!isAssembly && shapeTool->IsReference(label)) {
    if (shapeTool->GetReferredShape(label, referred)) {
      isAssembly = shapeTool->GetComponents(referred, children, Standard_False);
    }
  }

  if (isAssembly && children.Length() > 0) {
    int leafCount = countLeafs(shapeTool, label);
    assemblies.push_back({label, leafCount});
    for (Standard_Integer i = 1; i <= children.Length(); ++i) {
      collectAssemblies(shapeTool, children.Value(i), assemblies, visited);
    }
  }
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cout << "Usage: " << argv[0] << " <input.step> <output.step> [target_leaf_count | subassembly_label_entry]\n";
    return 1;
  }

  std::string inputPath = argv[1];
  std::string outputPath = argv[2];
  
  int targetLeafCount = 100;
  std::string targetLabelEntry = "";
  if (argc >= 4) {
    std::string arg = argv[3];
    if (arg.find(':') != std::string::npos) {
      targetLabelEntry = arg;
    } else {
      try {
        targetLeafCount = std::stoi(arg);
      } catch (...) {
        targetLabelEntry = arg;
      }
    }
  }

  std::cout << "Reading STEP file: " << inputPath << std::endl;
  Interface_Static::SetIVal("read.step.assembly.level", 1);
  Handle(TDocStd_Application) app = XCAFApp_Application::GetApplication();
  Handle(TDocStd_Document) doc;
  app->NewDocument("MDTV-XCAF", doc);

  STEPCAFControl_Reader reader;
  reader.SetNameMode(Standard_True);
  reader.SetColorMode(Standard_True);
  reader.SetLayerMode(Standard_True);
  reader.SetMatMode(Standard_True);

  if (reader.ReadFile(inputPath.c_str()) != IFSelect_RetDone) {
    std::cerr << "Error reading file\n";
    return 1;
  }
  if (!reader.Transfer(doc)) {
    std::cerr << "Error transferring to XCAF document\n";
    return 1;
  }

  Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  TDF_LabelSequence freeShapes;
  shapeTool->GetFreeShapes(freeShapes);
  std::cout << "Root free shapes: " << freeShapes.Length() << std::endl;

  TDF_Label selectedLabel;
  bool found = false;

  if (!targetLabelEntry.empty()) {
    // Find label by entry path
    TDF_Label label;
    TDF_Tool::Label(doc->GetData(), targetLabelEntry.c_str(), label);
    if (!label.IsNull()) {
      selectedLabel = label;
      found = true;
      std::cout << "Found specified label: " << targetLabelEntry << " (Name: " << labelName(label) << ", Leaf Count: " << countLeafs(shapeTool, label) << ")\n";
    } else {
      std::cerr << "Could not find label: " << targetLabelEntry << std::endl;
      return 1;
    }
  } else {
    // Collect all assembly labels and find the best one
    std::vector<std::pair<TDF_Label, int>> assemblies;
    std::set<std::string> visited;
    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
      collectAssemblies(shapeTool, freeShapes.Value(i), assemblies, visited);
    }

    std::cout << "Found " << assemblies.size() << " subassemblies/components in the tree.\n";
    
    // Sort assemblies by leaf count to list them
    std::sort(assemblies.begin(), assemblies.end(), [](const auto& a, const auto& b) {
      return a.second < b.second;
    });

    std::vector<std::pair<TDF_Label, int>> candidates;
    for (const auto& pair : assemblies) {
      if (pair.second >= 5 && pair.second <= targetLeafCount) {
        candidates.push_back(pair);
      }
    }

    if (!candidates.empty()) {
      // Choose the one closest to targetLeafCount (i.e. the last candidate after sorting)
      selectedLabel = candidates.back().first;
      found = true;
      std::cout << "Selected subassembly with " << candidates.back().second << " leaf shapes:\n";
      std::cout << "  Label: " << labelEntry(selectedLabel) << "\n";
      std::cout << "  Name: " << labelName(selectedLabel) << "\n";
      std::cout << "  Leaf Count: " << candidates.back().second << "\n";
      
      std::cout << "\nOther candidate subassemblies in range [5, " << targetLeafCount << "]:\n";
      for (const auto& pair : candidates) {
        std::cout << "  - " << labelEntry(pair.first) << " | " << labelName(pair.first) << " (Leaf Count: " << pair.second << ")\n";
      }
    } else {
      std::cout << "No subassemblies found in range [5, " << targetLeafCount << "].\n";
      if (!assemblies.empty()) {
        std::cout << "Assemblies outside range:\n";
        for (const auto& pair : assemblies) {
          std::cout << "  - " << labelEntry(pair.first) << " | " << labelName(pair.first) << " (Leaf Count: " << pair.second << ")\n";
        }
        // Let's pick the smallest assembly that has >= 5 shapes and is <= 2 * targetLeafCount
        for (const auto& pair : assemblies) {
          if (pair.second >= 5 && pair.second <= targetLeafCount * 2) {
            selectedLabel = pair.first;
            found = true;
            std::cout << "Selected smallest available assembly in range with " << pair.second << " leaf shapes:\n";
            std::cout << "  Label: " << labelEntry(selectedLabel) << " Name: " << labelName(selectedLabel) << "\n";
            break;
          }
        }
      }
    }
  }

  STEPCAFControl_Writer writer;
  writer.SetNameMode(Standard_True);
  writer.SetColorMode(Standard_True);
  writer.SetLayerMode(Standard_True);

  if (found) {
    std::cout << "Writing selected subassembly to: " << outputPath << std::endl;
    writer.Transfer(selectedLabel);
  } else {
    // If no assembly is found in target range, extract a subset of shapes/components
    TDF_LabelSequence labelsToTransfer;
    
    if (freeShapes.Length() > 1) {
      int countToExtract = std::min(freeShapes.Length(), targetLeafCount);
      std::cout << "Extracting first " << countToExtract << " free shapes...\n";
      for (int i = 1; i <= countToExtract; ++i) {
        labelsToTransfer.Append(freeShapes.Value(i));
      }
    } else if (freeShapes.Length() == 1) {
      // If we only have 1 root free shape, it is probably a root assembly.
      // Let's get its direct components/children and transfer the first N.
      TDF_Label rootLabel = freeShapes.Value(1);
      TDF_LabelSequence children;
      bool hasChildren = shapeTool->GetComponents(rootLabel, children, Standard_False);
      if (!hasChildren && shapeTool->IsReference(rootLabel)) {
        TDF_Label referred;
        if (shapeTool->GetReferredShape(rootLabel, referred)) {
          hasChildren = shapeTool->GetComponents(referred, children, Standard_False);
        }
      }
      
      if (hasChildren && children.Length() > 0) {
        int countToExtract = std::min(children.Length(), targetLeafCount);
        std::cout << "Root assembly has " << children.Length() << " children. Extracting first " << countToExtract << " direct children...\n";
        for (int i = 1; i <= countToExtract; ++i) {
          labelsToTransfer.Append(children.Value(i));
        }
      } else {
        std::cout << "Extracting the single root free shape...\n";
        labelsToTransfer.Append(rootLabel);
      }
    }
    
    if (labelsToTransfer.Length() > 0) {
      writer.Transfer(labelsToTransfer);
    } else {
      std::cerr << "No labels found to transfer!\n";
      return 1;
    }
  }


  if (writer.Write(outputPath.c_str()) != IFSelect_RetDone) {
    std::cerr << "Error writing STEP file\n";
    return 1;
  }

  std::cout << "Successfully wrote extracted components to: " << outputPath << std::endl;
  return 0;
}
