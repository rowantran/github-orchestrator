//! One error type for the CLI. Every message is meant to be actionable when printed as `gho: <message>`.

use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// An actionable failure.
    Message(String),
    /// A subprocess ran and exited unsuccessfully.
    Command { program: String, code: Option<i32>, stderr: String },
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Error::Message(message.into())
    }

    /// The exit code, when this is a subprocess failure.
    pub fn exit_code(&self) -> Option<i32> {
        match self {
            Error::Command { code, .. } => *code,
            Error::Message(_) => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Message(message) => f.write_str(message),
            Error::Command { program, code, stderr } => {
                let stderr = stderr.trim();
                // Keep the end of long output: that is where tools put the reason.
                let start = stderr.char_indices().rev().nth(2999).map_or(0, |(i, _)| i);
                match code {
                    Some(code) => write!(f, "{program} exited {code}: {}", &stderr[start..]),
                    None => write!(f, "{program} was killed by a signal: {}", &stderr[start..]),
                }
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Error::Message(error.to_string())
    }
}

/// Return early with an [`Error::Message`] built like `format!`.
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::Error::msg(format!($($arg)*)))
    };
}

/// Bail unless `condition` holds.
#[macro_export]
macro_rules! ensure {
    ($condition:expr, $($arg:tt)*) => {
        if !$condition {
            $crate::bail!($($arg)*);
        }
    };
}
