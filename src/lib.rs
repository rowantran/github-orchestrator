//! `gho`: register work as GitHub issues, list ready work, create Worktrunk worktrees.
//! Launching and managing implementer agents belongs to the orchestrator agent, not this crate.

pub mod brief;
pub mod cli;
pub mod config;
pub mod domain;
pub mod error;
pub mod github;
pub mod notes;
pub mod paths;
pub mod process;
pub mod work;
pub mod workspace;

pub use error::{Error, Result};
