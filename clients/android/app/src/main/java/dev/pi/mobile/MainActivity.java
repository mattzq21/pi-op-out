package dev.pi.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.webkit.WebSettings;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientPreferencesPlugin.class);
        registerPlugin(DictationPlugin.class);
        registerPlugin(DebugConnectionPlugin.class);
        registerPlugin(TailscaleStatusPlugin.class);
        super.onCreate(savedInstanceState);
        if (BuildConfig.DEBUG) {
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
    }
}
