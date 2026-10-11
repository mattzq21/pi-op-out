// JNI bridge from SpeechNative.java to the Cactus Needle and transcribe.cpp C APIs.
// Errors throw IllegalStateException with the engine's message. Results that carry text are JSON strings.
#include <jni.h>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <vector>
#include "needle.h"
#include "transcribe.h"

namespace {

constexpr int OUTPUT_CAPACITY = 1 << 20;

void fail(JNIEnv * env, const std::string & message) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), message.c_str());
}

std::string text(JNIEnv * env, jstring value) {
    if (!value) return "";
    const char * chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

jstring java(JNIEnv * env, const std::string & value) { return env->NewStringUTF(value.c_str()); }

std::vector<float> samples(JNIEnv * env, jfloatArray pcm) {
    std::vector<float> result(env->GetArrayLength(pcm));
    env->GetFloatArrayRegion(pcm, 0, static_cast<jsize>(result.size()), result.data());
    return result;
}

std::string json(const char * value, size_t size) {
    std::string result = "\"";
    for (size_t index = 0; index < size; index++) {
        const unsigned char c = static_cast<unsigned char>(value[index]);
        if (c == '"' || c == '\\') { result += '\\'; result += static_cast<char>(c); }
        else if (c == '\n') result += "\\n";
        else if (c == '\r') result += "\\r";
        else if (c == '\t') result += "\\t";
        else if (c < 0x20) { char escaped[8]; snprintf(escaped, sizeof escaped, "\\u%04x", c); result += escaped; }
        else result += static_cast<char>(c);
    }
    return result + "\"";
}

std::string json(const char * value) { return value ? json(value, strlen(value)) : "\"\""; }

std::string needleError(const char * fallback) {
    const char * error = needle_last_error();
    return error && *error ? error : fallback;
}

std::string status(const char * action, transcribe_status code) {
    return std::string(action) + ": " + transcribe_status_string(code);
}

/** One loaded transcribe.cpp model and its single session. */
struct Transcriber {
    transcribe_model * model = nullptr;
    transcribe_session * session = nullptr;
};

Transcriber * transcriber(jlong handle) { return reinterpret_cast<Transcriber *>(handle); }

std::string streamText(JNIEnv * env, transcribe_session * session) {
    transcribe_stream_text value;
    transcribe_stream_text_init(&value);
    const transcribe_status code = transcribe_stream_get_text(session, &value);
    if (code != TRANSCRIBE_OK) { fail(env, status("Could not read the live text", code)); return ""; }
    return "{\"committed\":" + json(value.committed_text, value.committed_text_bytes) + ",\"tentative\":" + json(value.tentative_text, value.tentative_text_bytes) + ",\"full\":" + json(value.full_text, value.full_text_bytes) + "}";
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL Java_dev_pi_mobile_SpeechNative_needleLoad(JNIEnv * env, jclass, jstring path) {
    std::ifstream file(text(env, path), std::ios::binary);
    if (!file) { fail(env, "Could not read the model file"); return; }
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (needle_load(bytes.data(), bytes.size()) < 0) { fail(env, needleError("Could not load the Needle model")); return; }
    if (!(needle_models() & NEEDLE_SPEECH)) fail(env, "This file is not a Needle speech model");
}

JNIEXPORT jstring JNICALL Java_dev_pi_mobile_SpeechNative_needleProcess(JNIEnv * env, jclass, jfloatArray pcm, jstring language) {
    std::vector<float> audio = samples(env, pcm);
    const std::string code = text(env, language);
    std::string out(OUTPUT_CAPACITY, '\0');
    if (needle_stream_transcribe_process(audio.data(), static_cast<int>(audio.size()), code.empty() ? nullptr : code.c_str(), nullptr, out.data(), OUTPUT_CAPACITY) < 0) {
        fail(env, needleError("Needle could not transcribe the audio"));
        return nullptr;
    }
    return java(env, out.c_str());
}

JNIEXPORT jstring JNICALL Java_dev_pi_mobile_SpeechNative_needleStop(JNIEnv * env, jclass) {
    std::string out(OUTPUT_CAPACITY, '\0');
    if (needle_stream_transcribe_stop(out.data(), OUTPUT_CAPACITY) < 0) { fail(env, needleError("Needle could not finish the transcription")); return nullptr; }
    return java(env, out.c_str());
}

JNIEXPORT jlong JNICALL Java_dev_pi_mobile_SpeechNative_transcribeLoad(JNIEnv * env, jclass, jstring path) {
    static std::once_flag backends;
    std::call_once(backends, [] { transcribe_init_backends_default(); });
    auto * loaded = new Transcriber();
    transcribe_status code = transcribe_model_load_file(text(env, path).c_str(), nullptr, &loaded->model);
    if (code != TRANSCRIBE_OK) { delete loaded; fail(env, status("Could not load the transcribe.cpp model", code)); return 0; }
    code = transcribe_session_init(loaded->model, nullptr, &loaded->session);
    if (code != TRANSCRIBE_OK) { transcribe_model_free(loaded->model); delete loaded; fail(env, status("Could not start transcribe.cpp", code)); return 0; }
    return reinterpret_cast<jlong>(loaded);
}

JNIEXPORT jstring JNICALL Java_dev_pi_mobile_SpeechNative_transcribeCapabilities(JNIEnv * env, jclass, jlong handle) {
    transcribe_capabilities capabilities;
    transcribe_capabilities_init(&capabilities);
    const transcribe_status code = transcribe_model_get_capabilities(transcriber(handle)->model, &capabilities);
    if (code != TRANSCRIBE_OK) { fail(env, status("Could not read the model capabilities", code)); return nullptr; }
    std::string languages = "[";
    for (int index = 0; index < capabilities.n_languages; index++) languages += (index ? "," : "") + json(capabilities.languages[index]);
    return java(env, "{\"languages\":" + languages + "],\"detect\":" + (capabilities.supports_language_detect ? "true" : "false") + ",\"streaming\":" + (capabilities.supports_streaming ? "true" : "false") + "}");
}

JNIEXPORT void JNICALL Java_dev_pi_mobile_SpeechNative_transcribeBegin(JNIEnv * env, jclass, jlong handle, jstring language) {
    const std::string code = text(env, language);
    transcribe_run_params params;
    transcribe_run_params_init(&params);
    params.language = code.empty() ? nullptr : code.c_str();
    const transcribe_status result = transcribe_stream_begin(transcriber(handle)->session, &params, nullptr);
    if (result != TRANSCRIBE_OK) fail(env, status("Could not start live transcription", result));
}

JNIEXPORT jstring JNICALL Java_dev_pi_mobile_SpeechNative_transcribeFeed(JNIEnv * env, jclass, jlong handle, jfloatArray pcm) {
    std::vector<float> audio = samples(env, pcm);
    if (audio.empty()) return nullptr;
    transcribe_stream_update update;
    transcribe_stream_update_init(&update);
    transcribe_session * session = transcriber(handle)->session;
    const transcribe_status code = transcribe_stream_feed(session, audio.data(), static_cast<int>(audio.size()), &update);
    if (code != TRANSCRIBE_OK) { fail(env, status("transcribe.cpp could not transcribe the audio", code)); return nullptr; }
    if (!update.committed_changed && !update.tentative_changed) return nullptr;
    const std::string result = streamText(env, session);
    return env->ExceptionCheck() ? nullptr : java(env, result);
}

JNIEXPORT jstring JNICALL Java_dev_pi_mobile_SpeechNative_transcribeFinish(JNIEnv * env, jclass, jlong handle) {
    transcribe_session * session = transcriber(handle)->session;
    const transcribe_status code = transcribe_stream_finalize(session, nullptr);
    if (code != TRANSCRIBE_OK) { fail(env, status("transcribe.cpp could not finish the transcription", code)); return nullptr; }
    const std::string result = streamText(env, session);
    return env->ExceptionCheck() ? nullptr : java(env, result);
}

JNIEXPORT void JNICALL Java_dev_pi_mobile_SpeechNative_transcribeReset(JNIEnv *, jclass, jlong handle) {
    transcribe_stream_reset(transcriber(handle)->session);
}

JNIEXPORT jstring JNICALL Java_dev_pi_mobile_SpeechNative_transcribeRun(JNIEnv * env, jclass, jlong handle, jfloatArray pcm, jstring language) {
    std::vector<float> audio = samples(env, pcm);
    const std::string code = text(env, language);
    transcribe_run_params params;
    transcribe_run_params_init(&params);
    params.language = code.empty() ? nullptr : code.c_str();
    transcribe_session * session = transcriber(handle)->session;
    const transcribe_status result = transcribe_run(session, audio.data(), static_cast<int>(audio.size()), &params);
    if (result != TRANSCRIBE_OK) { fail(env, status("transcribe.cpp could not transcribe the audio", result)); return nullptr; }
    return java(env, transcribe_full_text(session));
}

JNIEXPORT void JNICALL Java_dev_pi_mobile_SpeechNative_transcribeFree(JNIEnv *, jclass, jlong handle) {
    Transcriber * loaded = transcriber(handle);
    transcribe_session_free(loaded->session);
    transcribe_model_free(loaded->model);
    delete loaded;
}

}  // extern "C"

