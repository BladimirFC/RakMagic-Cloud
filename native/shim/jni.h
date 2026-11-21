#pragma once
// Subset used by NativeBridge, for an isolated Linux executable (no JVM).
#include <vector>
#include <cstdint>
#include <algorithm>
using jbyte = int8_t;
using jint = int;
using jboolean = bool;
using jclass = void*;
using jbyteArray = std::vector<jbyte>*;
#define JNIEXPORT
#define JNICALL
struct JNIEnv {
    int GetArrayLength(jbyteArray value) { return int(value->size()); }
    void GetByteArrayRegion(jbyteArray value, int start, int count, jbyte* out) { std::copy_n(value->data()+start,count,out); }
    void SetByteArrayRegion(jbyteArray value, int start, int count, const jbyte* in) { std::copy_n(in,count,value->data()+start); }
    jbyteArray NewByteArray(int count) { return new std::vector<jbyte>(count); }
};
