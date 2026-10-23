package dev.pi.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DebugConnection")
public class DebugConnectionPlugin extends Plugin {
    @PluginMethod
    public void load(PluginCall call) {
        JSObject result = new JSObject();
        if (BuildConfig.DEBUG) {
            String url = getActivity().getIntent().getStringExtra("piopDebugUrl");
            if (url != null) result.put("url", url);
            String token = getActivity().getIntent().getStringExtra("piopDebugToken");
            if (token != null) result.put("token", token);
            String hostUrl = getActivity().getIntent().getStringExtra("piopHostUrl");
            if (hostUrl != null) result.put("hostUrl", hostUrl);
        }
        call.resolve(result);
    }
}
