//! `gho wait review`: wait until someone submits a review on a pull request, so an implementer gets each
//! review as one batch of comments.
//!
//! The trigger is a submitted review, not a single comment: comments in a pending review stay invisible
//! until the reviewer submits it. Reviews written by agents (every text prefixed with `[agent:]`) never
//! end the wait, because agents use the same GitHub account as the user.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::{Error, Result, bail};

/// The prefix that marks text an agent wrote on GitHub.
pub const AGENT_PREFIX: &str = "[agent:]";

/// Review states that a submitted review can have. `PENDING` reviews are unsubmitted, `DISMISSED` withdrawn.
const SUBMITTED: [&str; 3] = ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"];

fn null_as_empty<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct User {
    pub login: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestState {
    Open,
    Closed,
}

/// A pull request, as the REST API returns it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PullRequestStatus {
    pub number: u64,
    pub html_url: String,
    pub state: RestState,
    pub merged: bool,
    pub draft: bool,
}

/// A pull request review, as the REST API returns it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Review {
    pub id: u64,
    /// `None` for deleted accounts.
    pub user: Option<User>,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub body: String,
    pub state: String,
    /// `None` until the review is submitted.
    #[serde(default)]
    pub submitted_at: Option<String>,
    pub html_url: String,
}

/// A pull request review comment, as the REST API returns it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReviewComment {
    pub id: u64,
    pub pull_request_review_id: Option<u64>,
    #[serde(default)]
    pub in_reply_to_id: Option<u64>,
    pub path: String,
    #[serde(default)]
    pub line: Option<u64>,
    #[serde(default)]
    pub original_line: Option<u64>,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub body: String,
    pub html_url: String,
}

/// Where reviews come from. Tests substitute a fixture for GitHub.
pub trait PullRequestReviews {
    fn pull_request_status(&self, number: u64) -> Result<PullRequestStatus>;
    fn reviews(&self, number: u64) -> Result<Vec<Review>>;
    fn review_comments(&self, number: u64) -> Result<Vec<ReviewComment>>;
}

fn agent_text(text: &str) -> bool {
    text.trim_start().starts_with(AGENT_PREFIX)
}

/// Whether an agent wrote this review. A reply to a review thread is a review with an empty body
/// and the reply as its only comment, so an empty body defers to the comments.
pub fn by_agent(review: &Review, comments: &[&ReviewComment]) -> bool {
    if !review.body.trim().is_empty() {
        return agent_text(&review.body);
    }
    !comments.is_empty() && comments.iter().all(|comment| agent_text(&comment.body))
}

/// The submitted reviews already handled: all before `at`, and those at `at` with these IDs.
/// GitHub gives submission times to the second, so two reviews can share one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor {
    at: Option<DateTime<Utc>>,
    ids: BTreeSet<u64>,
}

impl Cursor {
    /// Parse a cursor that `gho wait review` printed. `start` is the empty cursor.
    pub fn parse(value: &str) -> Result<Cursor> {
        if value == "start" {
            return Ok(Cursor::default());
        }
        let invalid = || Error::msg(format!("Invalid cursor {value:?}. Pass the cursor that gho wait review printed."));
        let mut parts = value.split(',');
        let at = parts.next().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).ok_or_else(invalid)?;
        let ids = parts.map(|id| id.parse().map_err(|_| invalid())).collect::<Result<BTreeSet<u64>>>()?;
        if ids.is_empty() {
            return Err(invalid());
        }
        Ok(Cursor { at: Some(at.with_timezone(&Utc)), ids })
    }

    pub fn covers(&self, at: DateTime<Utc>, id: u64) -> bool {
        match self.at {
            Some(cursor) => at < cursor || (at == cursor && self.ids.contains(&id)),
            None => false,
        }
    }

    fn advance(&mut self, at: DateTime<Utc>, id: u64) {
        match self.at {
            Some(cursor) if at < cursor => {}
            Some(cursor) if at == cursor => {
                self.ids.insert(id);
            }
            _ => {
                self.at = Some(at);
                self.ids = BTreeSet::from([id]);
            }
        }
    }
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Some(at) = self.at else { return f.write_str("start") };
        f.write_str(&at.to_rfc3339_opts(SecondsFormat::AutoSi, true))?;
        self.ids.iter().try_for_each(|id| write!(f, ",{id}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Comment {
    pub id: u64,
    pub url: String,
    pub path: String,
    /// The line in the current diff, or in the diff the comment was made on when it is outdated.
    pub line: Option<u64>,
    pub outdated: bool,
    /// The comment this one replies to, in an existing thread.
    pub in_reply_to: Option<u64>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SubmittedReview {
    pub id: u64,
    pub url: String,
    pub author: Option<String>,
    pub state: String,
    pub submitted_at: String,
    pub body: String,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum End {
    /// Someone submitted reviews; they are in `reviews`.
    Reviews,
    Merged,
    Closed,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub draft: bool,
}

/// What `gho wait review` prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub result: End,
    pub pull_request: PullRequest,
    pub reviews: Vec<SubmittedReview>,
    /// Pass to `--since` on the next wait, so these reviews do not end it again.
    pub cursor: String,
}

/// One `gho wait review` invocation on pull request `number`.
pub struct Watch<'a> {
    source: &'a dyn PullRequestReviews,
    number: u64,
    cursor: Cursor,
    /// Reviews this invocation found to be written by agents; their comments need not be read again.
    agents: HashSet<u64>,
    last: Option<PullRequest>,
}

impl<'a> Watch<'a> {
    pub fn new(source: &'a dyn PullRequestReviews, number: u64, cursor: Cursor) -> Self {
        Watch { source, number, cursor, agents: HashSet::new(), last: None }
    }

    /// One check: the outcome when the pull request is no longer open or has new reviews by someone else.
    pub fn check(&mut self) -> Result<Option<Outcome>> {
        let status = self.source.pull_request_status(self.number)?;
        if status.number != self.number {
            bail!("GitHub returned pull request #{} for #{}.", status.number, self.number);
        }
        let pull_request = PullRequest { number: status.number, url: status.html_url.clone(), draft: status.draft };
        self.last = Some(pull_request.clone());
        let ended = match (status.state, status.merged) {
            (_, true) => Some(End::Merged),
            (RestState::Closed, false) => Some(End::Closed),
            (RestState::Open, false) => None,
        };
        if let Some(end) = ended {
            return Ok(Some(self.outcome(end, pull_request, Vec::new())));
        }
        let mut candidates = Vec::new();
        for review in self.source.reviews(self.number)? {
            let Some(submitted) = &review.submitted_at else { continue };
            let at = DateTime::parse_from_rfc3339(submitted)
                .map_err(|_| Error::msg(format!("GitHub returned an invalid review time {submitted:?}.")))?
                .with_timezone(&Utc);
            if SUBMITTED.contains(&review.state.as_str())
                && !self.cursor.covers(at, review.id)
                && !self.agents.contains(&review.id)
            {
                candidates.push((at, review));
            }
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        candidates.sort_by_key(|(at, review)| (*at, review.id));
        let mut comments: HashMap<u64, Vec<ReviewComment>> = HashMap::new();
        for comment in self.source.review_comments(self.number)? {
            if let Some(review) = comment.pull_request_review_id {
                comments.entry(review).or_default().push(comment);
            }
        }
        let mut submitted = Vec::new();
        for (at, review) in candidates {
            let own = comments.remove(&review.id).unwrap_or_default();
            self.cursor.advance(at, review.id);
            if by_agent(&review, &own.iter().collect::<Vec<_>>()) {
                self.agents.insert(review.id);
                continue;
            }
            submitted.push(SubmittedReview {
                id: review.id,
                url: review.html_url,
                author: review.user.map(|user| user.login),
                state: review.state,
                submitted_at: review.submitted_at.unwrap_or_default(),
                body: review.body,
                comments: own
                    .into_iter()
                    .map(|comment| Comment {
                        id: comment.id,
                        url: comment.html_url,
                        path: comment.path,
                        line: comment.line.or(comment.original_line),
                        outdated: comment.line.is_none(),
                        in_reply_to: comment.in_reply_to_id,
                        body: comment.body,
                    })
                    .collect(),
            });
        }
        Ok((!submitted.is_empty()).then(|| self.outcome(End::Reviews, pull_request, submitted)))
    }

    /// The outcome when the wait times out.
    pub fn timed_out(&self) -> Outcome {
        let pull_request = self.last.clone().expect("the first check succeeded");
        self.outcome(End::Timeout, pull_request, Vec::new())
    }

    fn outcome(&self, result: End, pull_request: PullRequest, reviews: Vec<SubmittedReview>) -> Outcome {
        Outcome { result, pull_request, reviews, cursor: self.cursor.to_string() }
    }
}
