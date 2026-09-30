//! Path helpers with the same meaning as a shell: `~` expansion, and absolute paths without symlinks.

use std::path::{Component, Path, PathBuf};

/// Replace a leading `~` with `$HOME`.
pub fn expand_user(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

/// An absolute path with symlinks resolved. Unlike `fs::canonicalize`, the path need not exist:
/// existing components are canonicalized and missing ones are appended as written.
pub fn resolve(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::env::current_dir()?.join(expand_user(path));
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => {
                result.push(other);
                if let Ok(real) = result.canonicalize() {
                    result = real;
                }
            }
        }
    }
    Ok(result)
}
