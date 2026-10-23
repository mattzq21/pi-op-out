package dev.pi.mobile;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientPreferencesPlugin.class);
        registerPlugin(DebugConnectionPlugin.class);
        registerPlugin(TailscaleStatusPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) {
            Log.e("Piop", "Cannot initialize WebView bridge");
            return;
        }
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e("Piop", "WebView render process " + (detail.didCrash() ? "crashed" : "was killed by the system")
                    + "; priority=" + detail.rendererPriorityAtExit() + ". Recreating activity.");
                if (view.getParent() instanceof ViewGroup) {
                    ((ViewGroup) view.getParent()).removeView(view);
                }
                view.destroy();
                recreate();
                return true;
            }
        });
        if (BuildConfig.DEBUG) {
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
    }
}
