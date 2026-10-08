use super::{
    controller::{Host, Services},
    protocol::{kind, text, Result},
    providers::ProviderService,
    plugins::PluginService,
};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::{Arc, Weak};

pub(super) struct HostServices {
    providers: Arc<ProviderService>,
    plugins: PluginService,
}

impl HostServices {
    pub fn new(executable: String) -> Arc<Self> {
        Arc::new(Self {
            providers: ProviderService::new(executable.clone()),
            plugins: PluginService::new(executable),
        })
    }
}

impl Services for HostServices {
    fn bind(&self, host: Weak<Host>) {
        self.plugins.bind(host.clone());
        self.providers.bind(host);
    }
    fn initialize(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.plugins.initialize())
    }
    fn handle(&self, packet: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            match kind(&packet) {
                "provider_auth" => self.providers.handle(&text(&packet, "owner"), packet["request"].clone()).await,
                "plugin_call" | "plugin_status" | "plugin_idle" | "prepare_daemon_restart" => self.plugins.handle(packet).await,
                "provider_auth_cancel_owner" => {
                    self.providers.cancel_owner(&text(&packet, "owner")).await;
                    Ok(Value::Null)
                }
                _ => Err("Unknown host service operation".into()),
            }
        })
    }
    fn refresh_providers(&self) -> BoxFuture<'_, Result<u64>> {
        Box::pin(self.providers.check())
    }
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.plugins.shutdown().await;
            self.providers.shutdown().await;
        })
    }
}
