cmake_minimum_required(VERSION 3.22.1)
project(piopspeech C CXX)

# Speech engines for on-device dictation: transcribe.cpp built from a local checkout, and the Cactus Needle library.
# Native code always builds optimized: a debug build of the engines is too slow for live dictation.
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)

if(NOT TRANSCRIBE_CPP_DIR OR NOT EXISTS "${TRANSCRIBE_CPP_DIR}/include/transcribe.h")
  message(FATAL_ERROR "transcribe.cpp was not found at '${TRANSCRIBE_CPP_DIR}'. Set transcribe.cpp.dir in clients/android/local.properties or the TRANSCRIBE_CPP_DIR environment variable to a transcribe.cpp checkout.")
endif()
if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
  message(FATAL_ERROR "Cactus Needle has no Android library for ${ANDROID_ABI}. Build arm64-v8a only.")
endif()

set(TRANSCRIBE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_USE_SYSTEM_BLAS OFF CACHE BOOL "" FORCE)
set(TRANSCRIBE_INSTALL OFF CACHE BOOL "" FORCE)
# transcribe.cpp finds its public header through CMAKE_SOURCE_DIR, which is this project here.
include_directories("${TRANSCRIBE_CPP_DIR}/include")
add_subdirectory("${TRANSCRIBE_CPP_DIR}" transcribe-cpp EXCLUDE_FROM_ALL)

# Pinned Needle release: android-arm64/libneedle.a and needle.h from huggingface.co/Cactus-Compute/needle3.
set(NEEDLE_URL "https://huggingface.co/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b/android-arm64")
set(NEEDLE_DIR "${CMAKE_BINARY_DIR}/needle")
file(DOWNLOAD "${NEEDLE_URL}/libneedle.a" "${NEEDLE_DIR}/libneedle.a" EXPECTED_HASH SHA256=9be8b4b185ef1710f57179e3cc68835ac67fca8470bdbc6915d6966646d95385 STATUS needle_library)
file(DOWNLOAD "${NEEDLE_URL}/needle.h" "${NEEDLE_DIR}/needle.h" EXPECTED_HASH SHA256=a27dac4b3239eead91d124b7f7dbce5495c13019903fd817b68c16d39b055a99 STATUS needle_header)
add_library(needle STATIC IMPORTED)
set_target_properties(needle PROPERTIES IMPORTED_LOCATION "${NEEDLE_DIR}/libneedle.a")

add_library(piopspeech SHARED speech.cpp)
target_include_directories(piopspeech PRIVATE "${NEEDLE_DIR}")
target_link_libraries(piopspeech PRIVATE transcribe needle log m)

