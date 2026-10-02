//! Polling for `gho wait`: check a condition at an interval until it holds or a timeout passes.
//! Agents run these commands in the background, so a long wait costs them no context.

use std::thread;
use std::time::{Duration, Instant};

use crate::Result;

/// Consecutive failed checks tolerated after a successful one, so a network blip does not end a long wait.
pub const RETRIES: u32 = 5;

#[derive(Debug, Clone, Copy)]
pub struct Schedule {
    pub interval: Duration,
    /// `None` waits until the condition holds.
    pub timeout: Option<Duration>,
}

/// Run `check` until it returns `Some`, or return `None` once the timeout has passed.
///
/// The first check must succeed, so a wrong argument or missing access fails at once. After that, up to
/// [`RETRIES`] consecutive failures are reported on stderr and retried at the next interval.
pub fn poll<T>(schedule: &Schedule, mut check: impl FnMut() -> Result<Option<T>>) -> Result<Option<T>> {
    let start = Instant::now();
    let mut succeeded = false;
    let mut failures = 0;
    loop {
        match check() {
            Ok(Some(value)) => return Ok(Some(value)),
            Ok(None) => {
                succeeded = true;
                failures = 0;
            }
            Err(error) if succeeded && failures < RETRIES => {
                failures += 1;
                eprintln!("gho: {error} (retrying, {failures}/{RETRIES})");
            }
            Err(error) => return Err(error),
        }
        let elapsed = start.elapsed();
        let pause = match schedule.timeout {
            Some(timeout) if elapsed >= timeout => return Ok(None),
            Some(timeout) => schedule.interval.min(timeout - elapsed),
            None => schedule.interval,
        };
        thread::sleep(pause);
    }
}
