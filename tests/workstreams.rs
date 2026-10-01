use github_orchestrator::workstreams::label;

#[test]
fn workstream_labels_are_exact_and_do_not_inherit_parents() {
    assert_eq!(label("project-a").unwrap(), "gho:workstream:project-a");
    assert_eq!(label("project-a/feature-1").unwrap(), "gho:workstream:project-a/feature-1");
    assert_eq!(label("Team_2/v1.0").unwrap(), "gho:workstream:Team_2/v1.0");
}

#[test]
fn invalid_names_cannot_inject_options_labels_or_url_paths() {
    for name in [
        "",
        " ",
        " a",
        "a ",
        "a b",
        "-a",
        "--force",
        "a,b",
        "a\nb",
        "a\0b",
        "a\tb",
        "/a",
        "a/",
        "a//b",
        ".",
        "..",
        "../a",
        "a/../b",
        "a/.b",
        "a/-b",
        "a:b",
        "a?b",
        "a#b",
        "a%b",
        "a\\b",
        "a=b",
        "a;echo",
        "é",
        "gho:workstream:a",
    ] {
        assert!(label(name).is_err(), "accepted {name:?}");
    }
}

#[test]
fn labels_respect_github_length_limit() {
    assert_eq!(label(&"a".repeat(35)).unwrap().len(), 50);
    assert!(label(&"a".repeat(36)).is_err());
}
