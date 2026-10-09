
pub use headless::*;

mod headless {
    use serde::Serialize;
    use std::{any::{Any, TypeId}, collections::HashMap, ops::Deref, sync::{Arc, Mutex}};

    pub mod async_runtime {
        pub use tokio::spawn;

        #[cfg(test)]
        pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
            tokio::runtime::Runtime::new().expect("Could not create test runtime").block_on(future)
        }
    }

    type Listener = Arc<dyn Fn(Event) + Send + Sync>;

    struct Backend {
        states: HashMap<TypeId, Box<dyn Any + Send + Sync>>,
        listeners: Mutex<HashMap<String, Vec<Listener>>>,
    }

    #[derive(Clone)]
    pub struct AppHandle(Arc<Backend>);

    pub struct State<'a, T>(&'a T);
    impl<'a, T> State<'a, T> {
        pub fn inner(&self) -> &'a T { self.0 }
    }
    impl<T> Deref for State<'_, T> {
        type Target = T;
        fn deref(&self) -> &T { self.0 }
    }

    pub struct Event(String);
    impl Event {
        pub fn payload(&self) -> &str { &self.0 }
    }

    impl AppHandle {
        pub fn new() -> Self {
            let mut states: HashMap<TypeId, Box<dyn Any + Send + Sync>> = HashMap::new();
            macro_rules! state {
                ($kind:ty) => { states.insert(TypeId::of::<$kind>(), Box::new(<$kind>::default())); };
            }
            state!(crate::daemon_clients::DaemonClients);
            state!(crate::daemon_restart::Runtime);
            state!(crate::PiRuntime);
            state!(crate::TerminalRuntime);
            state!(crate::SessionIndexRuntime);
            state!(crate::BrokerRuntime);
            state!(crate::peers::PeerRuntime);
            state!(crate::dictation::DictationRuntime);
            Self(Arc::new(Backend { states, listeners: Mutex::new(HashMap::new()) }))
        }

        pub fn state<T: Any + Send + Sync>(&self) -> State<'_, T> {
            State(self.0.states.get(&TypeId::of::<T>()).and_then(|state| state.downcast_ref()).expect("Backend state was not registered"))
        }

        pub fn emit(&self, name: &str, payload: impl Serialize) -> Result<(), serde_json::Error> {
            let payload = serde_json::to_string(&payload)?;
            let listeners = self.0.listeners.lock().unwrap_or_else(|error| error.into_inner()).get(name).cloned().unwrap_or_default();
            for listener in listeners { listener(Event(payload.clone())); }
            Ok(())
        }

        pub fn listen_any(&self, name: &str, listener: impl Fn(Event) + Send + Sync + 'static) {
            self.0.listeners.lock().unwrap_or_else(|error| error.into_inner()).entry(name.into()).or_default().push(Arc::new(listener));
        }

    }
}
