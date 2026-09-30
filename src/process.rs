//! Argument-array subprocesses. No shell evaluation and no credential extraction.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use wait_timeout::ChildExt;

use crate::{Error, Result};

/// One subprocess invocation.
#[derive(Debug, Clone)]
pub struct Cmd {
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Added to (or replacing entries in) the inherited environment.
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

impl Cmd {
    pub fn new<I, S>(argv: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Cmd {
            argv: argv.into_iter().map(Into::into).collect(),
            cwd: None,
            env: Vec::new(),
            timeout: Duration::from_secs(60),
        }
    }

    pub fn cwd(mut self, path: &Path) -> Self {
        self.cwd = Some(path.to_path_buf());
        self
    }

    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn timeout(mut self, seconds: u64) -> Self {
        self.timeout = Duration::from_secs(seconds);
        self
    }

    fn program(&self) -> String {
        let first = self.argv.first().map(String::as_str).unwrap_or("");
        Path::new(first).file_name().map_or(first.into(), |name| name.to_string_lossy().into_owned())
    }
}

/// Runs commands and returns stdout. Tests substitute a fixture.
pub trait Runner {
    fn run(&self, cmd: &Cmd) -> Result<String>;
}

/// Runs real subprocesses.
pub struct System;

impl Runner for System {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        let (program, args) = cmd.argv.split_first().ok_or_else(|| Error::msg("Empty command."))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .envs(cmd.env.iter().map(|(k, v)| (k, v)))
            .envs([("GH_PROMPT_DISABLED", "1"), ("GIT_TERMINAL_PROMPT", "0"), ("NO_COLOR", "1")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &cmd.cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Error::msg(format!("Required executable not found: {program}")),
            _ => Error::msg(format!("Cannot run {program}: {error}")),
        })?;
        // Drain both pipes concurrently so a chatty child cannot block on a full pipe.
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());
        let status = match child.wait_timeout(cmd.timeout)? {
            Some(status) => status,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::msg(format!(
                    "{} timed out after {}s; no success assumed.",
                    cmd.program(),
                    cmd.timeout.as_secs()
                )));
            }
        };
        let stdout = stdout.join().unwrap_or_default();
        let stderr = stderr.join().unwrap_or_default();
        if !status.success() {
            return Err(Error::Command { program: cmd.program(), code: status.code(), stderr });
        }
        Ok(stdout)
    }
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// The first executable called `name` on `PATH` (or `name` itself if it contains a slash).
pub fn which(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let executable = |path: &Path| path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    if name.contains('/') {
        let path = PathBuf::from(name);
        return executable(&path).then_some(path);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| executable(path))
}
