//! Test-only adapter for the pinned upstream hidden API. Never linked to Centrail.
use tokscale_core::{parse_local_unified_messages_with_pricing_uncached, LocalParseOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || !matches!(args[2].as_str(), "codex" | "pi" | "gemini" | "claude" | "copilot") {
        return Err("usage: centrail_compare EXPLICIT_FIXTURE_HOME codex|pi|gemini|claude|copilot".into());
    }
    let home = std::fs::canonicalize(&args[1])?;
    if !home.is_dir() { return Err("fixture home must be a directory".into()); }
    let options = LocalParseOptions {
        home_dir: Some(home.to_str().ok_or("non-UTF8 fixture path")?.to_owned()),
        use_env_roots: false,
        clients: Some(vec![args[2].clone()]),
        since: None, until: None, year: None,
        scanner_settings: Default::default(),
    };
    let mut messages = parse_local_unified_messages_with_pricing_uncached(options, None).await?;
    messages.sort_by_key(|m| (m.timestamp, m.session_id.clone(), m.dedup_key.clone()));
    // Full UnifiedMessage is deliberate in this fixture-only laboratory: the public
    // ParsedMessage conversion loses identity and conflict evidence. Never upload it.
    println!("{}", serde_json::to_string(&serde_json::json!({
        "schemaVersion": 1,
        "upstreamCommit": "d4d1c751856e25913bce97bfbd7b254308863239",
        "client": args[2], "pricing": "disabled", "cache": "memory", "records": messages
    }))?);
    Ok(())
}
