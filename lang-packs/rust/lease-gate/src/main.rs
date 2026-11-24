use std::io::{self, Read};

fn field(json: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let Some(at) = json.find(&needle) else { return String::new() };
    let rest = &json[at + needle.len()..];
    let Some(colon) = rest.find(':') else { return String::new() };
    let rest = rest[colon + 1..].trim_start();
    if rest.starts_with("null") { return String::new(); }
    if !rest.starts_with('"') { return String::new(); }
    let mut out = String::new();
    let mut chars = rest[1..].chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' { if let Some(n) = chars.next() { out.push(n); } continue; }
        if ch == '"' { break; }
        out.push(ch);
    }
    out
}

fn main() {
    let mut json = String::new();
    io::stdin().read_to_string(&mut json).expect("stdin");
    let presented = field(&json, "presented_lease");
    let expected = field(&json, "lease_id");
    let status = field(&json, "status");
    let allowed = !presented.is_empty() && presented == expected && status == "RUNNING";
    let code = if allowed { "ok" } else { "lease_required" };
    println!("{{\"allowed\":{allowed},\"code\":\"{code}\"}}");
}
