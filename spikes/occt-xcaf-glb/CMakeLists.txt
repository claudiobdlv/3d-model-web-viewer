cmake_minimum_required(VERSION 3.16)

project(occt_xcaf_step_to_glb LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(OpenCASCADE REQUIRED)

add_executable(xcaf-step-to-glb
  src/main.cpp
)

target_include_directories(xcaf-step-to-glb PRIVATE ${OpenCASCADE_INCLUDE_DIR})
target_link_directories(xcaf-step-to-glb PRIVATE ${OpenCASCADE_LIBRARY_DIR})

target_link_libraries(xcaf-step-to-glb PRIVATE
  TKernel
  TKMath
  TKG2d
  TKG3d
  TKGeomBase
  TKBRep
  TKGeomAlgo
  TKTopAlgo
  TKPrim
  TKBO
  TKShHealing
  TKMesh
  TKXSBase
  TKSTEPBase
  TKSTEPAttr
  TKSTEP209
  TKSTEP
  TKLCAF
  TKCAF
  TKVCAF
  TKXCAF
  TKXDESTEP
)
