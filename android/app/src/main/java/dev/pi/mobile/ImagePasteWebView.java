package dev.pi.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.util.AttributeSet;
import android.util.Base64;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import com.getcapacitor.CapacitorWebView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.json.JSONObject;

public class ImagePasteWebView extends CapacitorWebView {
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
        String type = getContext().getContentResolver().getType(uri);
        if (type == null || !type.startsWith("image/")) return false;
        deliver(uri, () -> {});
        return true;
    }

    private void deliver(Uri uri, Runnable release) {
        String target = "__piopPaste_" + java.util.UUID.randomUUID().toString().replace("-", "");
        post(() -> evaluateJavascript("window[" + JSONObject.quote(target) + "] = document.activeElement", ignored -> {
            new Thread(() -> {
                try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new IllegalStateException("Could not read pasted image");
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (bytes.size() + count > 10 * 1024 * 1024) throw new IllegalStateException("Screenshot exceeds the 10 MB image limit");
                        bytes.write(buffer, 0, count);
                    }
                    JSONObject detail = new JSONObject();
                    detail.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                    detail.put("mimeType", getContext().getContentResolver().getType(uri));
                    emit(detail, target);
                } catch (Exception error) { report(error, target); }
                finally { release.run(); }
            }, "piop-image-paste").start();
        }));
    }

    private void report(Exception error, String target) {
        JSONObject detail = new JSONObject();
        try { detail.put("error", error.getMessage()); } catch (Exception ignored) { }
        emit(detail, target);
    }

    private void emit(JSONObject detail, String target) {
        String selection = target == null ? "document.activeElement" : "window[" + JSONObject.quote(target) + "]";
        String cleanup = target == null ? "" : "delete window[" + JSONObject.quote(target) + "];";
        post(() -> evaluateJavascript("(()=>{const target=" + selection + ";" + cleanup + " if(target?.isConnected) target.dispatchEvent(new CustomEvent('piop-native-image-paste',{bubbles:true,detail:" + detail + "}));})()", null));
    }
}
