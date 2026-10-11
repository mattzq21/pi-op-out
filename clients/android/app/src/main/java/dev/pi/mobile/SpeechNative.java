package dev.pi.mobile;

/** The bundled speech engines. All calls must come from one thread: Needle keeps one process-global model and a transcribe.cpp session is single-threaded. */
final class SpeechNative {
    static {
        System.loadLibrary("piopspeech");
    }

    private SpeechNative() {}

    static native void needleLoad(String path);

    /** Adds about one second of 16 kHz mono audio to the live transcription. Returns Needle's JSON result. */
    static native String needleProcess(float[] pcm, String language);

    /** Ends the live transcription. Returns Needle's JSON result for the unconfirmed tail. */
    static native String needleStop();

    static native long transcribeLoad(String path);

    /** Returns {"languages": [...], "detect": bool, "streaming": bool}. */
    static native String transcribeCapabilities(long model);

    static native void transcribeBegin(long model, String language);

    /** Returns {"committed", "tentative", "full"} when the live text changed, or null. */
    static native String transcribeFeed(long model, float[] pcm);

    /** Ends the live transcription. Returns {"committed", "tentative", "full"}. */
    static native String transcribeFinish(long model);

    static native void transcribeReset(long model);

    /** Transcribes a whole recording for models that cannot stream. */
    static native String transcribeRun(long model, float[] pcm, String language);

    static native void transcribeFree(long model);
}
