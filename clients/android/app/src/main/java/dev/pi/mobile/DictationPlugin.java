package dev.pi.mobile;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** On-device dictation: runs the speech engine chosen in the client preferences and saves speech models in the app's files. */
@CapacitorPlugin(name = "Dictation")
public class DictationPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private static final int MAX_SAMPLES = SAMPLE_RATE * 120;
    private static final int MAX_FEED_SAMPLES = SAMPLE_RATE * 5;
    private static final List<String> NEEDLE_LANGUAGES = Arrays.asList("en", "de", "fr", "es", "it", "nl", "pl");
    private static final Pattern FILE_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]*");

    /** Runs every native engine call, one after another. */
    private final ExecutorService engine = Executors.newSingleThreadExecutor();
    /** Runs the idle timers of streams. */
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();
    private static final int IDLE_SECONDS = 15;
    private final Object lock = new Object();

    /** The engine settings that are loaded or loading. A change reloads the engine. */
    private String settingsKey;
    private int generation;
    private JSObject configuration = state(true, null);
    private Stream stream;
    /** Used only on the engine thread. */
    private Loaded loaded;

    private final Map<String, Download> downloads = new LinkedHashMap<>();
    private final Map<String, String> downloadErrors = new LinkedHashMap<>();

    /** A loaded engine. */
    private static final class Loaded {
        final String kind;
        final long model;
        final boolean streaming;
        final String language;

        Loaded(String kind, long model, boolean streaming, String language) {
            this.kind = kind;
            this.model = model;
            this.streaming = streaming;
            this.language = language;
        }
    }

    /** One live dictation. Its audio and text fields are used only on the engine thread. */
    private static final class Stream {
        final String id;
        int samples;
        boolean closed;
        /** Closes the stream when no audio arrives for IDLE_SECONDS. Guarded by lock. */
        ScheduledFuture<?> idle;
        float[] pending = new float[0];
        String committed = "";
        String tentative = "";

        Stream(String id) {
            this.id = id;
        }
    }

    private static final class Download {
        volatile boolean cancelled;
        long received;
    }

    @Override
    public void load() {
        reload();
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            generation++;
            stream = null;
            for (Download download : downloads.values()) download.cancelled = true;
        }
        timers.shutdownNow();
        engine.execute(this::unload);
        engine.shutdown();
    }

    private static JSObject state(boolean loading, String error) {
        JSObject result = new JSObject();
        result.put("enabled", false);
        result.put("loading", loading);
        if (error != null) result.put("error", error);
        return result;
    }

    private static String setting(JSONObject settings, String field) {
        String value = settings == null ? "" : settings.optString(field, "").trim();
        return value;
    }

    /** Reads the client preferences and reloads the engine when its settings changed. */
    void reload() {
        String kind;
        String model;
        String language;
        try (ClientPreferencesStorage storage = new ClientPreferencesStorage(getContext())) {
            String stored = storage.read().settings;
            storage.commit();
            JSONObject settings = stored == null ? null : new JSONObject(stored);
            kind = setting(settings, "dictationEngine");
            if (kind.isEmpty()) kind = "transcribe.cpp";
            model = setting(settings, "dictationModelPath");
            language = setting(settings, "dictationLanguage").toLowerCase(Locale.ROOT);
        } catch (Exception error) {
            publish(state(false, "Could not read the dictation settings: " + error.getMessage()), null);
            return;
        }
        String key = kind + "\n" + model + "\n" + language;
        int current;
        synchronized (lock) {
            if (key.equals(settingsKey)) return;
            settingsKey = key;
            current = ++generation;
            closeStream("Dictation stopped because the speech engine changed");
            configuration = state(true, null);
        }
        notifyListeners("dictation", configuration);
        final String engineKind = kind;
        engine.execute(() -> {
            JSObject result;
            try {
                result = loadEngine(engineKind, model, language);
            } catch (Throwable error) {
                result = state(false, message(error));
            }
            publish(result, current);
        });
    }

    private void publish(JSObject result, Integer expected) {
        synchronized (lock) {
            if (expected != null && expected != generation) return;
            configuration = result;
        }
        notifyListeners("dictation", result);
    }

    private static String message(Throwable error) {
        String text = error.getMessage();
        return text == null || text.isEmpty() ? error.toString() : text;
    }

    private void unload() {
        if (loaded != null && loaded.kind.equals("transcribe.cpp")) SpeechNative.transcribeFree(loaded.model);
        loaded = null;
    }

    /** Runs on the engine thread. */
    private JSObject loadEngine(String kind, String model, String language) throws Exception {
        unload();
        if (model.isEmpty()) return state(false, "No dictation model is configured");
        if (!new File(model).isFile()) return state(false, "The model file " + model + " does not exist");
        List<String> languages = new ArrayList<>();
        boolean detect;
        if (kind.equals("needle")) {
            SpeechNative.needleLoad(model);
            languages.addAll(NEEDLE_LANGUAGES);
            detect = true;
            loaded = new Loaded(kind, 0, true, language);
        } else if (kind.equals("transcribe.cpp")) {
            long handle = SpeechNative.transcribeLoad(model);
            JSONObject capabilities;
            try {
                capabilities = new JSONObject(SpeechNative.transcribeCapabilities(handle));
            } catch (Throwable error) {
                SpeechNative.transcribeFree(handle);
                throw error;
            }
            JSONArray known = capabilities.getJSONArray("languages");
            for (int index = 0; index < known.length(); index++) languages.add(known.getString(index));
            detect = capabilities.getBoolean("detect");
            loaded = new Loaded(kind, handle, capabilities.getBoolean("streaming"), language);
        } else {
            return state(false, "Unknown speech engine " + kind);
        }
        String name = kind.equals("needle") ? "This Needle model" : "This transcribe.cpp model";
        if (!language.isEmpty() && !languages.isEmpty() && !languages.contains(language)) {
            unload();
            return state(false, name + " cannot use the language '" + language + "'. Use one of: " + String.join(", ", languages));
        }
        if (language.isEmpty() && !detect && languages.size() > 1) {
            unload();
            return state(false, name + " cannot detect the language. Set one of: " + String.join(", ", languages));
        }
        JSObject result = new JSObject();
        result.put("enabled", true);
        result.put("loading", false);
        result.put("engine", kind);
        result.put("language", language);
        result.put("languages", new JSArray(languages));
        result.put("detectLanguage", detect);
        return result;
    }

    @PluginMethod
    public void configuration(PluginCall call) {
        synchronized (lock) {
            call.resolve(configuration);
        }
    }

    /** Must hold lock. Stops the current stream and tells its owner why. */
    private void closeStream(String error) {
        Stream current = stream;
        if (current == null) return;
        stream = null;
        if (current.idle != null) current.idle.cancel(false);
        engine.execute(() -> reset(current));
        if (error != null) {
            JSObject event = new JSObject();
            event.put("id", current.id);
            event.put("error", error);
            notifyListeners("dictation-stream", event);
        }
    }

    /** Runs on the engine thread. Throws away the stream's audio and text. */
    private void reset(Stream current) {
        if (current.closed) return;
        current.closed = true;
        if (loaded == null) return;
        try {
            if (loaded.kind.equals("needle")) SpeechNative.needleStop();
            else if (loaded.streaming) SpeechNative.transcribeReset(loaded.model);
        } catch (Throwable ignored) {
            // The engine starts the next stream from a clean state either way.
        }
    }

    private Stream owned(String id) {
        if (stream == null || !stream.id.equals(id)) throw new IllegalStateException("This dictation is no longer running");
        return stream;
    }

    /** Called with lock held. Restarts the wait for the next audio of this stream. */
    private void armIdle(Stream current) {
        if (current.idle != null) current.idle.cancel(false);
        current.idle = timers.schedule(() -> {
            synchronized (lock) {
                if (stream == current) closeStream("Dictation stopped because no audio arrived for " + IDLE_SECONDS + " seconds");
            }
        }, IDLE_SECONDS, TimeUnit.SECONDS);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Stream started;
        synchronized (lock) {
            if (!configuration.optBoolean("enabled")) {
                String error = configuration.optString("error", "");
                call.reject(error.isEmpty() ? "Dictation is unavailable" : "Dictation is unavailable: " + error);
                return;
            }
            closeStream("Dictation stopped because a new dictation started");
            started = new Stream(UUID.randomUUID().toString());
            stream = started;
            armIdle(started);
        }
        engine.execute(() -> {
            if (started.closed || loaded == null) return;
            try {
                if (loaded.kind.equals("transcribe.cpp") && loaded.streaming) SpeechNative.transcribeBegin(loaded.model, loaded.language);
            } catch (Throwable error) {
                fail(started, message(error));
            }
        });
        JSObject result = new JSObject();
        result.put("id", started.id);
        call.resolve(result);
    }

    /** Runs on the engine thread. Ends a stream after an engine error. */
    private void fail(Stream failed, String error) {
        synchronized (lock) {
            if (stream == failed) closeStream(error);
        }
    }

    private static float[] decode(String audio) {
        byte[] bytes = Base64.decode(audio, Base64.NO_WRAP);
        if (bytes.length % 2 != 0) throw new IllegalArgumentException("Invalid dictation audio");
        ShortBuffer shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
        float[] samples = new float[shorts.remaining()];
        for (int index = 0; index < samples.length; index++) samples[index] = shorts.get(index) / 32768f;
        return samples;
    }

    private static float[] concat(float[] left, float[] right) {
        float[] result = Arrays.copyOf(left, left.length + right.length);
        System.arraycopy(right, 0, result, left.length, right.length);
        return result;
    }

    private static String join(String left, String right) {
        return !left.isEmpty() && !right.isEmpty() ? (left + " " + right).trim() : left.isEmpty() ? right : left;
    }

    @PluginMethod
    public void feed(PluginCall call) {
        String id = call.getString("id", "");
        float[] samples;
        try {
            samples = decode(call.getString("audio", ""));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid dictation audio");
            return;
        }
        if (samples.length > MAX_FEED_SAMPLES) { call.reject("Invalid dictation audio"); return; }
        Stream current;
        synchronized (lock) {
            try {
                current = owned(id);
            } catch (IllegalStateException error) {
                call.reject(error.getMessage());
                return;
            }
            if (current.samples + samples.length > MAX_SAMPLES) { call.reject("Dictation recording is too long"); return; }
            current.samples += samples.length;
            armIdle(current);
        }
        engine.execute(() -> {
            if (current.closed || loaded == null) return;
            try {
                process(current, samples);
            } catch (Throwable error) {
                fail(current, message(error));
            }
        });
        call.resolve();
    }

    private void emitText(Stream current) {
        JSObject event = new JSObject();
        event.put("id", current.id);
        event.put("committed", current.committed);
        event.put("tentative", current.tentative);
        notifyListeners("dictation-stream", event);
    }

    /** Runs on the engine thread. Needle takes about one second at a time; transcribe.cpp takes any amount. */
    private void process(Stream current, float[] samples) throws Exception {
        if (loaded.kind.equals("needle")) {
            current.pending = concat(current.pending, samples);
            while (current.pending.length >= SAMPLE_RATE) {
                float[] chunk = Arrays.copyOf(current.pending, SAMPLE_RATE);
                current.pending = Arrays.copyOfRange(current.pending, SAMPLE_RATE, current.pending.length);
                needleStep(current, SpeechNative.needleProcess(chunk, loaded.language));
            }
        } else if (loaded.streaming) {
            String update = SpeechNative.transcribeFeed(loaded.model, samples);
            if (update == null) return;
            JSONObject text = new JSONObject(update);
            current.committed = text.getString("committed").trim();
            current.tentative = text.getString("tentative").trim();
            emitText(current);
        } else {
            current.pending = concat(current.pending, samples);
        }
    }

    private void needleStep(Stream current, String result) throws Exception {
        JSONObject step = new JSONObject(result);
        String committed = step.optString("text", "").trim();
        String pending = step.optString("pending", "").trim();
        if (committed.isEmpty() && pending.equals(current.tentative)) return;
        current.committed = join(current.committed, committed);
        current.tentative = pending;
        emitText(current);
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("id", "");
        Stream current;
        synchronized (lock) {
            try {
                current = owned(id);
            } catch (IllegalStateException error) {
                call.reject(error.getMessage());
                return;
            }
            stream = null;
            if (current.idle != null) current.idle.cancel(false);
        }
        engine.execute(() -> {
            if (current.closed || loaded == null) { call.reject("This dictation is no longer running"); return; }
            try {
                String text;
                if (loaded.kind.equals("needle")) {
                    if (current.pending.length > 0) needleStep(current, SpeechNative.needleProcess(current.pending, loaded.language));
                    current.pending = new float[0];
                    current.closed = true;
                    needleStep(current, SpeechNative.needleStop());
                    text = join(current.committed, current.tentative);
                } else if (loaded.streaming) {
                    current.closed = true;
                    JSONObject result = new JSONObject(SpeechNative.transcribeFinish(loaded.model));
                    text = (result.getString("committed") + result.getString("tentative")).trim();
                } else {
                    current.closed = true;
                    text = current.pending.length == 0 ? "" : SpeechNative.transcribeRun(loaded.model, current.pending, loaded.language).trim();
                }
                JSObject result = new JSObject();
                result.put("text", text);
                call.resolve(result);
            } catch (Throwable error) {
                reset(current);
                call.reject(message(error));
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        synchronized (lock) {
            if (stream != null && stream.id.equals(id)) closeStream(null);
        }
        call.resolve();
    }

    private File directory() {
        return new File(getContext().getFilesDir(), "models/speech");
    }

    /** Must hold lock. */
    private JSObject models() {
        JSArray items = new JSArray();
        File[] files = directory().listFiles();
        if (files != null) {
            Arrays.sort(files);
            for (File file : files) {
                if (!file.isFile() || file.getName().endsWith(".part") || downloads.containsKey(file.getName())) continue;
                JSObject item = new JSObject();
                item.put("file", file.getName());
                item.put("saved", true);
                items.put(item);
            }
        }
        for (Map.Entry<String, Download> entry : downloads.entrySet()) {
            JSObject item = new JSObject();
            item.put("file", entry.getKey());
            item.put("saved", false);
            item.put("received", entry.getValue().received);
            items.put(item);
        }
        for (Map.Entry<String, String> entry : downloadErrors.entrySet()) {
            JSObject item = new JSObject();
            item.put("file", entry.getKey());
            item.put("saved", false);
            item.put("error", entry.getValue());
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("directory", directory().getAbsolutePath());
        result.put("items", items);
        return result;
    }

    private void publishModels() {
        JSObject result;
        synchronized (lock) {
            result = models();
        }
        notifyListeners("dictation-models", result);
    }

    @PluginMethod
    public void models(PluginCall call) {
        synchronized (lock) {
            call.resolve(models());
        }
    }

    private static String fileName(PluginCall call) {
        String file = call.getString("file", "");
        if (!FILE_NAME.matcher(file).matches() || file.endsWith(".part")) throw new IllegalArgumentException("Invalid model file name");
        return file;
    }

    @PluginMethod
    public void saveModel(PluginCall call) {
        String file;
        try {
            file = fileName(call);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        long size = call.getData().optLong("size", 0);
        if (!url.startsWith("https://") || !sha256.matches("[0-9a-f]{64}") || size <= 0) { call.reject("Invalid model download"); return; }
        Download download = new Download();
        synchronized (lock) {
            if (downloads.containsKey(file)) { call.reject("This model is already being saved"); return; }
            downloads.put(file, download);
            downloadErrors.remove(file);
        }
        publishModels();
        call.resolve();
        new Thread(() -> {
            String error = null;
            File part = new File(directory(), file + ".part");
            try {
                save(download, url, size, sha256, part, new File(directory(), file));
            } catch (Throwable failure) {
                error = download.cancelled ? null : message(failure);
            }
            if (part.exists() && !part.delete()) error = error == null ? "Could not remove " + part : error;
            synchronized (lock) {
                downloads.remove(file);
                if (error != null) downloadErrors.put(file, error);
            }
            publishModels();
        }, "piop-model-" + file).start();
    }

    private void save(Download download, String url, long size, String sha256, File part, File target) throws Exception {
        File folder = target.getParentFile();
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("Could not create " + folder);
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(60_000);
        try {
            int code = connection.getResponseCode();
            if (code != 200) throw new IllegalStateException("The download failed with HTTP " + code);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[1 << 16];
            long received = 0;
            long shownPercent = -1;
            try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(part)) {
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (download.cancelled) throw new IllegalStateException("Cancelled");
                    received += count;
                    if (received > size) throw new IllegalStateException("The download is larger than expected");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                    long percent = received * 100 / size;
                    if (percent != shownPercent) {
                        shownPercent = percent;
                        synchronized (lock) {
                            download.received = received;
                        }
                        publishModels();
                    }
                }
                ((FileOutputStream) output).getFD().sync();
            }
            if (received != size) throw new IllegalStateException("The download is incomplete");
            StringBuilder hex = new StringBuilder();
            for (byte value : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", value));
            if (!hex.toString().equals(sha256)) throw new IllegalStateException("The download does not match its checksum");
            if (!part.renameTo(target)) throw new IllegalStateException("Could not save " + target);
        } finally {
            connection.disconnect();
        }
    }

    @PluginMethod
    public void cancelModel(PluginCall call) {
        try {
            String file = fileName(call);
            synchronized (lock) {
                Download download = downloads.get(file);
                if (download != null) download.cancelled = true;
            }
            call.resolve();
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void removeModel(PluginCall call) {
        try {
            String file = fileName(call);
            File target = new File(directory(), file);
            synchronized (lock) {
                if (downloads.containsKey(file)) { call.reject("Stop saving this model first"); return; }
                downloadErrors.remove(file);
            }
            if (target.exists() && !target.delete()) { call.reject("Could not remove " + target); return; }
            publishModels();
            call.resolve();
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
        }
    }
}
