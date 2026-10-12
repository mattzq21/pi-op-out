package dev.pi.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.ContentResolver;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.util.AttributeSet;
import android.util.Base64;
import android.util.Log;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import com.getcapacitor.CapacitorWebView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Semaphore;
import org.json.JSONObject;

public class ImagePasteWebView extends CapacitorWebView {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Semaphore READ_SLOTS = new Semaphore(2);
    private final Set<ImageRead> reads = new HashSet<>();
    private boolean destroyed;

    public ImagePasteWebView(Context context, AttributeSet attrs) { super(context, attrs); }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo info) {
        InputConnection original = super.onCreateInputConnection(info);
        if (original == null) return null;
        EditorInfoCompat.setContentMimeTypes(info, new String[] { "image/*" });
        InputConnection content = InputConnectionCompat.createWrapper(original, info, (image, flags, options) -> {
            try {
                if ((flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) image.requestPermission();
                deliver(image.getContentUri(), image::releasePermission);
                return true;
            } catch (Exception error) { report(error, null); return false; }
        });
        return new InputConnectionWrapper(content, false) {
            @Override
            public boolean performContextMenuAction(int id) {
                if (id == android.R.id.paste && pasteImage()) return true;
                return super.performContextMenuAction(id);
            }
        };
    }

    private boolean pasteImage() {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return false;
        Uri uri = clip.getItemAt(0).getUri();
        if (uri == null) return false;
        if (!clip.getDescription().hasMimeType("image/*")) return false;
        deliver(uri, () -> {});
        return true;
    }

    @Override
    protected void onDetachedFromWindow() {
        cancelReads();
        super.onDetachedFromWindow();
    }

    @Override
    public void destroy() {
        cancelReads();
        destroyed = true;
        super.destroy();
    }

    private void cancelReads() {
        for (ImageRead read : new HashSet<>(reads)) read.finish(null, new IllegalStateException("Image paste cancelled"));
    }

    /** Input connection calls run on Chromium's input thread, so all WebView and read-list work moves to the main thread. */
    private void deliver(Uri uri, Runnable release) {
        MAIN.post(() -> deliverOnMain(uri, release));
    }

    private void deliverOnMain(Uri uri, Runnable release) {
        if (destroyed || !isAttachedToWindow() || !READ_SLOTS.tryAcquire()) {
            try { release.run(); } catch (Exception error) { Log.e("piop-image-paste", "Could not release image permission", error); }
            report(new IllegalStateException("Image paste unavailable or too many reads in progress"), null);
            return;
        }
        ImageRead read = new ImageRead(this, uri, release);
        reads.add(read);
        MAIN.postDelayed(read.timeout, 10000);
        try {
            evaluateJavascript("window[" + JSONObject.quote(read.target) + "] = document.activeElement", ignored -> read.start());
        } catch (Exception error) { read.finish(null, error); }
    }

    private static final class ImageRead {
        final WeakReference<ImagePasteWebView> view;
        final ContentResolver resolver;
        final Uri uri;
        final Runnable release;
        final String target = "__piopPaste_" + java.util.UUID.randomUUID().toString().replace("-", "");
        final CancellationSignal signal = new CancellationSignal();
        final Runnable timeout = () -> finish(null, new IllegalStateException("Image paste timed out"));
        InputStream input;
        Thread worker;
        boolean finished, started, readDone = true, cleanupDone;

        ImageRead(ImagePasteWebView view, Uri uri, Runnable release) {
            this.view = new WeakReference<>(view);
            resolver = view.getContext().getApplicationContext().getContentResolver();
            this.uri = uri;
            this.release = release;
        }

        synchronized void start() {
            if (finished || started) return;
            started = true;
            readDone = false;
            worker = new Thread(this::read, "piop-image-paste");
            worker.start();
        }

        void read() {
            JSONObject detail = new JSONObject();
            try {
                try (AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r", signal)) {
                    if (descriptor == null) throw new IllegalStateException("Could not read pasted image");
                    try (InputStream stream = descriptor.createInputStream()) {
                        synchronized (this) {
                            if (finished) return;
                            input = stream;
                        }
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                        byte[] buffer = new byte[8192];
                        int count;
                        while ((count = stream.read(buffer)) != -1) {
                            signal.throwIfCanceled();
                            if (bytes.size() + count > 10 * 1024 * 1024) throw new IllegalStateException("Screenshot exceeds the 10 MB image limit");
                            bytes.write(buffer, 0, count);
                        }
                        detail.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                        detail.put("mimeType", resolver.getType(uri));
                    }
                }
                finish(detail, null);
            } catch (Exception error) {
                Log.e("piop-image-paste", "Could not read pasted image", error);
                finish(null, error);
            }
            finally {
                synchronized (this) {
                    input = null;
                    readDone = true;
                    if (cleanupDone) READ_SLOTS.release();
                }
            }
        }

        void finish(JSONObject detail, Exception error) {
            synchronized (this) {
                if (finished) return;
                finished = true;
            }
            MAIN.removeCallbacks(timeout);
            if (error != null) Log.e("piop-image-paste", "Image paste failed", error);
            MAIN.post(() -> {
                ImagePasteWebView current = view.get();
                if (current == null) return;
                current.reads.remove(this);
                if (error == null) current.emit(detail, target);
                else current.report(error, target);
            });
            new Thread(() -> {
                InputStream stream;
                synchronized (this) { stream = input; }
                try {
                    if (error != null && worker != null) worker.interrupt();
                    release.run();
                } catch (Exception failure) { Log.e("piop-image-paste", "Could not release image permission", failure); }
                try { if (stream != null) stream.close(); }
                catch (Exception failure) { Log.e("piop-image-paste", "Could not close pasted image", failure); }
                try { signal.cancel(); }
                catch (Exception failure) { Log.e("piop-image-paste", "Could not cancel image read", failure); }
                finally {
                    synchronized (this) {
                        cleanupDone = true;
                        if (readDone) READ_SLOTS.release();
                    }
                }
            }, "piop-image-paste-cleanup").start();
        }
    }

    private void report(Exception error, String target) {
        JSONObject detail = new JSONObject();
        Log.e("piop-image-paste", "Image paste failed", error);
        try { detail.put("error", error.getMessage() == null ? error.toString() : error.getMessage()); }
        catch (Exception failure) { Log.e("piop-image-paste", "Could not report image error", failure); }
        emit(detail, target);
    }

    private void emit(JSONObject detail, String target) {
        String selection = target == null ? "document.activeElement" : "window[" + JSONObject.quote(target) + "]";
        String cleanup = target == null ? "" : "delete window[" + JSONObject.quote(target) + "];";
        MAIN.post(() -> {
            if (destroyed) return;
            evaluateJavascript("(()=>{const target=" + selection + ";" + cleanup + " if(target?.isConnected) target.dispatchEvent(new CustomEvent('piop-native-image-paste',{bubbles:true,detail:" + detail + "}));})()", null);
        });
    }
}
