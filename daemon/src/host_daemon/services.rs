use super::{
    controller::Host,
    protocol::{kind, text, Result},
    providers::ProviderService,
    plugins::PluginService,
};
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
    pub fn bind(&self, host: Weak<Host>) {
        self.plugins.bind(host.clone());
        self.providers.bind(host);
    }
    pub async fn initialize(&self) {
        self.plugins.initialize().await;
    }
    pub async fn handle(&self, packet: Value) -> Result<Value> {
        match kind(&packet) {
            "provider_auth" => self.providers.handle(&text(&packet, "owner"), packet["request"].clone()).await,
            "plugin_call" | "plugin_status" | "plugin_idle" | "prepare_daemon_restart" => self.plugins.handle(packet).await,
            "provider_auth_cancel_owner" => {
                self.providers.cancel_owner(&text(&packet, "owner")).await;
                Ok(Value::Null)
            }
            _ => Err("Unknown host service operation".into()),
        }
    }
    pub async fn refresh_providers(&self) -> Result<u64> {
        self.providers.check().await
    }
    pub async fn shutdown(&self) {
        self.plugins.shutdown().await;
        self.providers.shutdown().await;
    }
}
