//! Agent skills: folders with a `SKILL.md` in a shared folder (`~/.agents/skills`) and in each coding agent's folder.
//! An agent's copy is often a symlink into the shared folder. `real` shows which copies are the same skill.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::jobs;

/// Relative to home. The first is shared.
const PLACES: &[(&str, &str, &str)] = &[
    ("global", "Global", ".agents/skills"),
    ("claude", "Claude Code", ".claude/skills"),
    ("codex", "Codex", ".codex/skills"),
    ("gemini", "Gemini CLI", ".gemini/skills"),
    ("cursor", "Cursor", ".cursor/skills"),
    ("copilot", "GitHub Copilot", ".copilot/skills"),
    ("windsurf", "Windsurf", ".codeium/windsurf/skills"),
    ("antigravity", "Antigravity", ".gemini/antigravity/skills"),
    ("opencode", "OpenCode", ".config/opencode/skills"),
    ("amp", "Amp", ".config/amp/skills"),
    ("augment", "Augment", ".augment/skills"),
    ("pi", "Pi", ".pi/agent/skills"),
    ("goose", "Goose", ".config/goose/skills"),
    ("factory", "Factory Droid", ".factory/skills"),
    ("openclaw", "OpenClaw", ".openclaw/skills"),
    ("hermes", "Hermes", ".hermes/skills"),
];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    name: String,
    path: String,
    description: String,
    /// Path with symlinks resolved. Copies with the same `real` are one skill.
    real: String,
    linked: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillPlace {
    id: &'static str,
    label: &'static str,
    dir: String,
    skills: Vec<Skill>,
}

/// Flattens folded or quoted descriptions to one line.
fn front_matter(text: &str) -> (Option<String>, String) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, String::new());
    }
    let (mut name, mut desc) = (None, String::new());
    let mut in_desc = false;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if in_desc && (line.starts_with(' ') || line.starts_with('\t')) {
            if !desc.is_empty() {
                desc.push(' ');
            }
            desc.push_str(line.trim());
            continue;
        }
        in_desc = false;
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        match key.trim() {
            "name" => name = Some(value),
            "description" => {
                in_desc = value.is_empty() || value.starts_with('>') || value.starts_with('|');
                desc = if in_desc { String::new() } else { value };
            }
            _ => {}
        }
    }
    (name, desc)
}

fn read_place(dir: &Path) -> Vec<Skill> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Skill> = rd
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let path = e.path();
            let text = fs::read_to_string(path.join("SKILL.md")).ok()?;
            let (name, description) = front_matter(&text);
            let linked = fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
            Some(Skill {
                name: name.unwrap_or_else(|| e.file_name().to_string_lossy().into_owned()),
                real: fs::canonicalize(&path).ok()?.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                description,
                linked,
            })
        })
        .collect();
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

#[tauri::command]
pub async fn list_skills() -> Result<Vec<SkillPlace>, String> {
    let home = dirs::home_dir().ok_or("No home folder")?;
    jobs::blocking(move || {
        PLACES
            .iter()
            .map(|&(id, label, rel)| (id, label, home.join(rel)))
            .filter(|(_, _, dir)| dir.is_dir())
            .map(|(id, label, dir)| SkillPlace {
                id,
                label,
                skills: read_place(&dir),
                dir: dir.to_string_lossy().into_owned(),
            })
            .collect()
    })
    .await
}

fn place_dir(place: &str) -> Result<PathBuf, String> {
    let rel = PLACES.iter().find(|p| p.0 == place).ok_or("Unknown agent")?.2;
    Ok(dirs::home_dir().ok_or("No home folder")?.join(rel))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[tauri::command]
pub async fn create_skill(place: String, name: String) -> Result<String, String> {
    if !valid_name(&name) {
        return Err("Use lowercase letters, digits and hyphens for a skill name.".into());
    }
    let dir = place_dir(&place)?.join(&name);
    jobs::blocking(move || {
        if fs::symlink_metadata(&dir).is_ok() {
            return Err(format!("A skill named \"{name}\" already exists."));
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("SKILL.md");
        let body = format!(
            "---\nname: {name}\ndescription: What this skill does and when to use it.\n---\n\n# {name}\n\nInstructions for the agent go here.\n"
        );
        fs::write(&file, body).map_err(|e| e.to_string())?;
        Ok(file.to_string_lossy().into_owned())
    })
    .await?
}

/// True if some agent already has the skill. Only such a skill can be linked. Otherwise any folder with a SKILL.md could be planted into an agent's skills.
fn is_listed(home: &Path, skill: &Path) -> bool {
    PLACES.iter().any(|p| read_place(&home.join(p.2)).iter().any(|s| Path::new(&s.real) == skill))
}

#[tauri::command]
pub async fn link_skill(skill: String, place: String) -> Result<(), String> {
    let dir = place_dir(&place)?;
    let home = dirs::home_dir().ok_or("No home folder")?;
    jobs::blocking(move || {
        let skill = fs::canonicalize(&skill).map_err(|e| e.to_string())?;
        if !skill.join("SKILL.md").is_file() {
            return Err("That folder has no SKILL.md.".into());
        }
        if !is_listed(&home, &skill) {
            return Err("Only a skill one of your agents already has can be shared.".into());
        }
        let name = skill.file_name().ok_or("invalid path")?;
        let link = dir.join(name);
        if fs::symlink_metadata(&link).is_ok() {
            return Err(format!("A skill named \"{}\" is already there.", name.to_string_lossy()));
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&skill, &link).map_err(|e| e.to_string())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_only_skills_an_agent_has() {
        let home = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("doftar-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let (own, stray) = (home.join(".claude/skills/own"), home.join("Downloads/stray"));
        for d in [&own, &stray] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        }
        assert!(is_listed(&home, &own));
        assert!(!is_listed(&home, &stray));
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn reads_front_matter() {
        let (n, d) = front_matter("---\nname: adapt\ndescription: \"Fits screens.\"\nargs:\n  - x\n---\nbody");
        assert_eq!((n.as_deref(), d.as_str()), (Some("adapt"), "Fits screens."));
        let (n, d) = front_matter("---\ndescription: >\n  One\n  two\nname: x\n---\n");
        assert_eq!((n.as_deref(), d.as_str()), (Some("x"), "One two"));
        assert_eq!(front_matter("# no front matter").0, None);
    }

    #[test]
    fn checks_names() {
        assert!(valid_name("my-skill2"));
        for bad in ["", "-x", "My", "a/b", "..", "a b"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
