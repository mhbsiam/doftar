use std::sync::{Mutex, MutexGuard};

/// `lock()` that still works after a thread panicked while holding the mutex.
/// Std poisons the mutex then, and every later `lock().unwrap()` panics too, so one fault would stop file watching or jobs until relaunch.
pub trait Locked<T> {
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mutex_still_locks_after_its_holder_panicked() {
        let m = std::sync::Arc::new(Mutex::new(1));
        let held = m.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        *m.locked() += 1;
        assert_eq!(*m.locked(), 2);
    }
}
