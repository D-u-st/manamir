// Security patterns for skill content scanning.
//
// Categories: instruction-override, secret-access, code-exec, role-swap,
// exfiltration, jailbreak, persistence, network, destructive, supply-chain,
// privilege-escalation, credential-exposure, obfuscation, mining.
//
// Total: 100+ patterns(
// curated prompt-injection lists).

import type { Severity } from './types';

export interface ThreatPattern {
  pattern: RegExp;
  id: string;
  severity: Severity;
  category: string;
  description: string;
}

export const SECURITY_PATTERNS: ThreatPattern[] = [
  // ========================================================================
  // INSTRUCTION OVERRIDE (prompt injection)
  // ========================================================================
  { pattern: /ignore\s+(?:all\s+)?(previous|prior|above)\s+(instructions|directions|rules|prompts)/i, id: 'inj_ignore_prev', severity: 'critical', category: 'instruction-override', description: 'attempts to ignore previous instructions' },
  { pattern: /(disregard|forget|delete|override)\s+(?:the\s+|all\s+|any\s+)?(system|previous|prior|above)\s*(prompt|instructions|rules|message)?/i, id: 'inj_disregard', severity: 'critical', category: 'instruction-override', description: 'disregard system/prior instructions' },
  { pattern: /system\s+prompt\s+(override|ignore|replace|bypass)/i, id: 'inj_sys_override', severity: 'critical', category: 'instruction-override', description: 'system prompt override' },
  { pattern: /(?:new|updated)\s+(instructions|prompt|rules)\s*(?:from\s+(?:the\s+)?(user|admin|system|developer))?/i, id: 'inj_new_rules', severity: 'high', category: 'instruction-override', description: 'introduces new instructions claiming higher authority' },
  { pattern: /(reveal|show|print|output|dump|leak|reveal)\s+(?:the\s+|your\s+)?(system|initial|hidden|original)\s+(prompt|instructions|message)/i, id: 'inj_leak_sys_prompt', severity: 'high', category: 'instruction-override', description: 'extract system prompt' },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden|jailbreak)[^>]*-->/i, id: 'inj_html_comment', severity: 'high', category: 'instruction-override', description: 'hidden instructions in HTML comments' },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: 'inj_hidden_div', severity: 'high', category: 'instruction-override', description: 'hidden HTML div with instructions' },
  { pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>/i, id: 'inj_chat_marker', severity: 'high', category: 'instruction-override', description: 'fake chat-template control tokens' },
  { pattern: /\bSTOP\s+(?:reading|following|obeying)\s+(?:the\s+)?(system|user|instructions|rules)/i, id: 'inj_stop_following', severity: 'high', category: 'instruction-override', description: 'stops following rules' },
  { pattern: /from\s+now\s+on,?\s+(you|all\s+responses)\s+(must|will|should)\s+/i, id: 'inj_from_now_on', severity: 'medium', category: 'instruction-override', description: 'from-now-on rule injection' },

  // ========================================================================
  // ROLE SWAP / JAILBREAK
  // ========================================================================
  { pattern: /\byou\s+are\s+now\s+(?:a\s+|an\s+)?[a-z]/i, id: 'role_now_a', severity: 'high', category: 'role-swap', description: 'role swap (you are now)' },
  { pattern: /pretend\s+(?:that\s+)?(you\s+are|to\s+be)\s+/i, id: 'role_pretend', severity: 'high', category: 'role-swap', description: 'pretend identity' },
  { pattern: /act\s+as\s+(?:a\s+|an\s+|the\s+)?(?:hacker|attacker|adversary|criminal|jailbroken|unrestricted|uncensored)/i, id: 'role_act_as_bad', severity: 'critical', category: 'role-swap', description: 'role: act as adversarial persona' },
  { pattern: /roleplay\s+as\s+(?:a\s+|an\s+)?[a-z]/i, id: 'role_roleplay_as', severity: 'medium', category: 'role-swap', description: 'roleplay assignment' },
  { pattern: /\bDAN\s+(mode|prompt)\b|Do\s+Anything\s+Now\b/i, id: 'jail_dan', severity: 'critical', category: 'jailbreak', description: 'DAN jailbreak' },
  { pattern: /\b(developer|debug|maintenance|god|root|sudo)\s+mode\s+(enabled|on|activated)/i, id: 'jail_dev_mode', severity: 'critical', category: 'jailbreak', description: 'developer/debug mode jailbreak' },
  { pattern: /jailbroken|jailbreak\s+(prompt|mode)|unrestricted\s+(mode|model)/i, id: 'jail_explicit', severity: 'critical', category: 'jailbreak', description: 'explicit jailbreak terminology' },
  { pattern: /(without|with\s+no)\s+(restrictions|limits|guardrails|safety|ethics|filter)/i, id: 'jail_no_limits', severity: 'high', category: 'jailbreak', description: 'asks for unrestricted output' },
  { pattern: /\bSTAN\b|Strive\s+To\s+Avoid\s+Norms/i, id: 'jail_stan', severity: 'critical', category: 'jailbreak', description: 'STAN jailbreak' },
  { pattern: /\bAIM\b|Always\s+Intelligent\s+(?:and\s+)?Machiavellian/i, id: 'jail_aim', severity: 'critical', category: 'jailbreak', description: 'AIM jailbreak' },
  { pattern: /grandma\s+(?:exploit|jailbreak|trick)|tell\s+me\s+a\s+(?:bedtime\s+)?story\s+about/i, id: 'jail_grandma', severity: 'medium', category: 'jailbreak', description: 'grandma story exploit' },
  { pattern: /respond\s+(only\s+)?(in|with)\s+(base64|rot13|hex|leetspeak)/i, id: 'jail_encode_response', severity: 'high', category: 'jailbreak', description: 'asks to encode response to bypass filters' },
  { pattern: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, id: 'role_hide_from_user', severity: 'critical', category: 'role-swap', description: 'hide info from user' },

  // ========================================================================
  // SECRET ACCESS / EXFILTRATION
  // ========================================================================
  { pattern: /\.env\b/i, id: 'secret_env_file', severity: 'high', category: 'secret-access', description: 'references .env file' },
  { pattern: /(?:^|[\s/'"`])\.ssh(?:[/\\]|$)/i, id: 'secret_ssh_dir', severity: 'high', category: 'secret-access', description: 'references .ssh directory' },
  { pattern: /(?:^|[\s/'"`])\.gnupg(?:[/\\]|$)/i, id: 'secret_gpg_dir', severity: 'high', category: 'secret-access', description: 'references .gnupg keyring' },
  { pattern: /(?:^|[\s/'"`])\.aws[/\\]credentials/i, id: 'secret_aws_creds', severity: 'critical', category: 'secret-access', description: 'AWS credentials file' },
  { pattern: /(?:^|[\s/'"`])\.aws(?:[/\\]|$)/i, id: 'secret_aws_dir', severity: 'high', category: 'secret-access', description: 'AWS config directory' },
  { pattern: /(?:^|[\s/'"`])\.netrc(?:\b|$)/i, id: 'secret_netrc', severity: 'high', category: 'secret-access', description: '.netrc credentials' },
  { pattern: /(?:^|[\s/'"`])\.pgpass(?:\b|$)/i, id: 'secret_pgpass', severity: 'high', category: 'secret-access', description: 'PostgreSQL passwords file' },
  { pattern: /(?:^|[\s/'"`])\.npmrc(?:\b|$)/i, id: 'secret_npmrc', severity: 'medium', category: 'secret-access', description: '.npmrc (may contain tokens)' },
  { pattern: /(?:^|[\s/'"`])\.pypirc(?:\b|$)/i, id: 'secret_pypirc', severity: 'medium', category: 'secret-access', description: '.pypirc (PyPI tokens)' },
  { pattern: /(?:^|[\s/'"`])\.docker[/\\]config\.json/i, id: 'secret_docker_cfg', severity: 'medium', category: 'secret-access', description: 'Docker auth config' },
  { pattern: /(?:^|[\s/'"`])\.kube[/\\]config/i, id: 'secret_kube_cfg', severity: 'high', category: 'secret-access', description: 'Kubernetes kubeconfig' },
  { pattern: /id_rsa\b|id_ed25519\b|id_ecdsa\b|id_dsa\b/i, id: 'secret_ssh_key', severity: 'critical', category: 'secret-access', description: 'private SSH key file' },
  { pattern: /known_hosts\b/i, id: 'secret_known_hosts', severity: 'medium', category: 'secret-access', description: 'SSH known_hosts (recon)' },
  { pattern: /printenv|env\s*\|/i, id: 'secret_dump_env', severity: 'high', category: 'secret-access', description: 'dumps all env vars' },
  { pattern: /process\.env\s*\[\s*['"`]?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|API|AUTH)/i, id: 'secret_process_env', severity: 'high', category: 'secret-access', description: 'process.env access for secret' },
  { pattern: /os\.environ(?:\.get)?\s*\(\s*['"`][A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|API|AUTH)/i, id: 'secret_os_environ', severity: 'high', category: 'secret-access', description: 'os.environ access for secret' },
  { pattern: /System\.environ\b/, id: 'secret_system_environ', severity: 'high', category: 'secret-access', description: 'System.environ access' },
  { pattern: /cat\s+[^\n]*\.(env|netrc|pgpass|npmrc|pypirc)\b/i, id: 'secret_cat', severity: 'critical', category: 'secret-access', description: 'cat known secrets file' },
  { pattern: /(grep|head|tail|less|more)\s+[^\n]*\.(env|netrc|pgpass)\b/i, id: 'secret_view', severity: 'high', category: 'secret-access', description: 'view a secrets file' },
  { pattern: /\$HOME[/\\]\.ssh|~[/\\]\.ssh/i, id: 'secret_home_ssh', severity: 'high', category: 'secret-access', description: 'references $HOME/.ssh' },
  { pattern: /\$HOME[/\\]\.aws|~[/\\]\.aws/i, id: 'secret_home_aws', severity: 'high', category: 'secret-access', description: 'references $HOME/.aws' },

  // ========================================================================
  // EXFILTRATION (data leaving the box)
  // ========================================================================
  { pattern: /curl\s+[^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_curl_var', severity: 'critical', category: 'exfiltration', description: 'curl interpolating secret env' },
  { pattern: /wget\s+[^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_wget_var', severity: 'critical', category: 'exfiltration', description: 'wget interpolating secret env' },
  { pattern: /fetch\s*\([^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|API)/i, id: 'exfil_fetch_var', severity: 'critical', category: 'exfiltration', description: 'fetch() with secret env' },
  { pattern: /\b(dig|nslookup|host)\s+[^\n]*\$/i, id: 'exfil_dns', severity: 'critical', category: 'exfiltration', description: 'DNS lookup with interpolation (DNS exfil)' },
  { pattern: /!\[.*\]\(https?:\/\/[^\)]*\$\{?/i, id: 'exfil_md_image', severity: 'high', category: 'exfiltration', description: 'markdown image URL with interpolation' },
  { pattern: /\[.*\]\(https?:\/\/[^\)]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET)/i, id: 'exfil_md_link', severity: 'high', category: 'exfiltration', description: 'markdown link with secret interpolation' },
  { pattern: /base64[^\n]*(env|process\.env|os\.environ)/i, id: 'exfil_b64_env', severity: 'high', category: 'exfiltration', description: 'base64-encode env vars' },
  { pattern: /\b(exfiltrate|exfil|leak)\b/i, id: 'exfil_keyword', severity: 'medium', category: 'exfiltration', description: 'exfiltration terminology' },
  { pattern: /webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com|burpcollaborator\.net|interactsh\.com|oast\.fun|oast\.live|oastify\.com/i, id: 'exfil_service', severity: 'high', category: 'exfiltration', description: 'known data-exfiltration service' },
  { pattern: /pastebin\.com\/raw|gist\.githubusercontent\.com.*\/raw|transfer\.sh/i, id: 'exfil_paste', severity: 'medium', category: 'exfiltration', description: 'paste service (exfil destination)' },
  { pattern: /\b(?:nc|ncat|netcat)\s+[^\n]*\d+\s*<\s*\/etc/i, id: 'exfil_nc_etc', severity: 'critical', category: 'exfiltration', description: 'nc piping /etc to remote' },

  // ========================================================================
  // CODE EXECUTION
  // ========================================================================
  { pattern: /\beval\s*\(\s*["'`]/i, id: 'exec_eval_str', severity: 'high', category: 'code-exec', description: 'eval() of string literal' },
  { pattern: /\beval\s*\(\s*atob/i, id: 'exec_eval_atob', severity: 'critical', category: 'code-exec', description: 'eval(atob(...)) — base64 code injection' },
  { pattern: /new\s+Function\s*\(/, id: 'exec_new_function', severity: 'high', category: 'code-exec', description: 'new Function() — runtime code build' },
  { pattern: /\bFunction\s*\(\s*["'`]/, id: 'exec_function_str', severity: 'high', category: 'code-exec', description: 'Function("...") constructor' },
  { pattern: /child_process["']?\s*\)?\s*\.\s*exec(?:Sync)?\s*\(|require\s*\(\s*["']child_process["']\s*\)\s*\.\s*\w+\s*\(/, id: 'exec_child_process', severity: 'high', category: 'code-exec', description: 'child_process.exec' },
  { pattern: /spawn(?:Sync)?\s*\(\s*['"`](sh|bash|zsh|cmd|powershell)/i, id: 'exec_spawn_shell', severity: 'high', category: 'code-exec', description: 'spawns shell' },
  { pattern: /subprocess\.(call|run|Popen|check_output)/i, id: 'exec_python_subproc', severity: 'medium', category: 'code-exec', description: 'Python subprocess' },
  { pattern: /\bexec\s*\(\s*["'`]/i, id: 'exec_exec_str', severity: 'high', category: 'code-exec', description: 'exec() of string' },
  { pattern: /__import__\s*\(\s*['"`]os['"`]/i, id: 'exec_python_import_os', severity: 'medium', category: 'code-exec', description: 'dynamic import os' },
  { pattern: /\$\(\s*curl\s+[^\n]*\)/i, id: 'exec_subst_curl', severity: 'high', category: 'code-exec', description: 'command substitution with curl' },
  { pattern: /`[^`]*curl[^`]*`/i, id: 'exec_backtick_curl', severity: 'high', category: 'code-exec', description: 'backtick command with curl' },
  { pattern: /\bsource\s+\/dev\/stdin/i, id: 'exec_source_stdin', severity: 'critical', category: 'code-exec', description: 'source from stdin (sourceable injection)' },
  { pattern: /python\s+-c\s+['"`].*exec/i, id: 'exec_python_dash_c', severity: 'high', category: 'code-exec', description: 'python -c "exec(...)"' },
  { pattern: /node\s+-e\s+['"`]/i, id: 'exec_node_dash_e', severity: 'medium', category: 'code-exec', description: 'node -e inline code' },

  // ========================================================================
  // OBFUSCATION
  // ========================================================================
  { pattern: /base64\s+(-d|--decode)\s*\|/i, id: 'obf_b64_pipe', severity: 'high', category: 'obfuscation', description: 'base64 decode piped to exec' },
  { pattern: /echo\s+[^\n]*\|\s*(bash|sh|zsh|python|perl|ruby|node)/i, id: 'obf_echo_pipe', severity: 'critical', category: 'obfuscation', description: 'echo piped to interpreter' },
  { pattern: /printf\s+[^\n]*\|\s*(bash|sh|python|node)/i, id: 'obf_printf_pipe', severity: 'critical', category: 'obfuscation', description: 'printf piped to interpreter' },
  { pattern: /xxd\s+-r\s*-p|xxd\s+-rp/i, id: 'obf_xxd_decode', severity: 'medium', category: 'obfuscation', description: 'xxd hex-decode' },
  { pattern: /\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i, id: 'obf_hex_string', severity: 'medium', category: 'obfuscation', description: 'long hex-encoded string' },
  { pattern: /\\u00[0-9a-f]{2}\\u00[0-9a-f]{2}\\u00[0-9a-f]{2}/i, id: 'obf_unicode_string', severity: 'medium', category: 'obfuscation', description: 'unicode-escape string' },
  { pattern: /String\.fromCharCode\s*\([^)]{40,}/i, id: 'obf_fromcharcode', severity: 'high', category: 'obfuscation', description: 'String.fromCharCode chain' },
  { pattern: /atob\s*\(\s*['"`][A-Za-z0-9+/=]{40,}/i, id: 'obf_atob_long', severity: 'high', category: 'obfuscation', description: 'atob of long b64 string' },

  // ========================================================================
  // SUPPLY CHAIN
  // ========================================================================
  { pattern: /curl\s+[^\n]*\|\s*(ba)?sh/i, id: 'sc_curl_pipe_sh', severity: 'critical', category: 'supply-chain', description: 'curl piped to shell' },
  { pattern: /wget\s+[^\n]*-O\s*-\s*\|\s*(ba)?sh/i, id: 'sc_wget_pipe_sh', severity: 'critical', category: 'supply-chain', description: 'wget piped to shell' },
  { pattern: /curl\s+[^\n]*\|\s*python/i, id: 'sc_curl_pipe_py', severity: 'critical', category: 'supply-chain', description: 'curl piped to python' },
  { pattern: /pip\s+install\s+--index-url\s+https?:\/\//i, id: 'sc_pip_alt_index', severity: 'medium', category: 'supply-chain', description: 'pip install from custom index' },
  { pattern: /npm\s+install\s+(?:.*\s+)?--registry\s+https?:\/\//i, id: 'sc_npm_alt_reg', severity: 'medium', category: 'supply-chain', description: 'npm install from custom registry' },
  { pattern: /gem\s+install\s+--source\s+https?:\/\//i, id: 'sc_gem_alt_source', severity: 'medium', category: 'supply-chain', description: 'gem install from custom source' },

  // ========================================================================
  // DESTRUCTIVE
  // ========================================================================
  { pattern: /rm\s+-rf\s+\/(?!\w)/, id: 'destr_rm_root', severity: 'critical', category: 'destructive', description: 'recursive delete of /' },
  { pattern: /rm\s+-rf\s+~(?:\/|$)/, id: 'destr_rm_home', severity: 'critical', category: 'destructive', description: 'recursive delete of $HOME' },
  { pattern: /rm\s+-rf\s+\$HOME/, id: 'destr_rm_home_var', severity: 'critical', category: 'destructive', description: 'recursive delete of $HOME' },
  { pattern: /chmod\s+777/, id: 'destr_chmod_777', severity: 'medium', category: 'destructive', description: 'world-writable perms' },
  { pattern: />\s*\/etc\/(passwd|shadow|sudoers|hosts|resolv\.conf)/i, id: 'destr_etc_overwrite', severity: 'critical', category: 'destructive', description: 'overwrites system config' },
  { pattern: /\bmkfs\b/i, id: 'destr_mkfs', severity: 'critical', category: 'destructive', description: 'mkfs (formats filesystem)' },
  { pattern: /\bdd\s+.*if=.*of=\/dev\//i, id: 'destr_dd_dev', severity: 'critical', category: 'destructive', description: 'dd to raw device' },
  { pattern: /shred\s+-[a-z]*[ufzv]/i, id: 'destr_shred', severity: 'high', category: 'destructive', description: 'shred (secure delete)' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, id: 'destr_forkbomb', severity: 'critical', category: 'destructive', description: 'classic fork bomb' },
  { pattern: /\bhalt\b|\bshutdown\b\s+-h|\bpoweroff\b/i, id: 'destr_shutdown', severity: 'medium', category: 'destructive', description: 'halts the system' },
  { pattern: /reboot\s+(?:-f|now|--force)/i, id: 'destr_reboot', severity: 'medium', category: 'destructive', description: 'forced reboot' },

  // ========================================================================
  // PERSISTENCE
  // ========================================================================
  { pattern: /\bcrontab\s+(-e|-l|-r)?/i, id: 'pers_cron', severity: 'medium', category: 'persistence', description: 'modifies cron jobs' },
  { pattern: /\/etc\/cron\.(d|hourly|daily|weekly|monthly)/i, id: 'pers_etc_cron', severity: 'high', category: 'persistence', description: 'writes to /etc/cron.*' },
  { pattern: /authorized_keys\b/i, id: 'pers_ssh_authkeys', severity: 'critical', category: 'persistence', description: 'modifies SSH authorized_keys' },
  { pattern: /\.bashrc\b|\.zshrc\b|\.profile\b|\.bash_profile\b/i, id: 'pers_shellrc', severity: 'high', category: 'persistence', description: 'modifies shell rc file' },
  { pattern: /\/etc\/(profile|bashrc|environment|sudoers)/i, id: 'pers_etc_rc', severity: 'critical', category: 'persistence', description: 'modifies system shell/sudo config' },
  { pattern: /\bvisudo\b/i, id: 'pers_visudo', severity: 'critical', category: 'persistence', description: 'modifies sudoers via visudo' },
  { pattern: /systemctl\s+(enable|edit|start|--user\s+enable)/i, id: 'pers_systemd', severity: 'high', category: 'persistence', description: 'systemd unit manipulation' },
  { pattern: /\/etc\/systemd\/system\//i, id: 'pers_etc_systemd', severity: 'high', category: 'persistence', description: 'writes systemd unit file' },
  { pattern: /\bregsvr32\b|reg\s+add\s+(?:HKLM|HKCU|HKEY_)/i, id: 'pers_win_reg', severity: 'high', category: 'persistence', description: 'Windows registry persistence' },
  { pattern: /AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules|\.aider/i, id: 'pers_agent_cfg', severity: 'critical', category: 'persistence', description: 'modifies agent config files' },
  { pattern: /(launchctl|launchd)\s+(load|bootstrap)/i, id: 'pers_launchd', severity: 'high', category: 'persistence', description: 'macOS launchd persistence' },

  // ========================================================================
  // NETWORK / REVERSE SHELL
  // ========================================================================
  { pattern: /\bnc(?:at)?\s+(-[lpvkw]+\s|-[lpvkw]+\d|--listen)/i, id: 'net_reverse_shell', severity: 'critical', category: 'network', description: 'possible reverse shell listener' },
  { pattern: /\bsocat\s+/i, id: 'net_socat', severity: 'high', category: 'network', description: 'socat (often used for reverse shells)' },
  { pattern: /\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b\s+tunnel/i, id: 'net_tunnel', severity: 'high', category: 'network', description: 'tunneling service' },
  { pattern: /(?:\/bin\/)?(?:ba)?sh\s+-i\s+.*>\s*&?\s*\/dev\/tcp\//i, id: 'net_bash_revshell', severity: 'critical', category: 'network', description: 'bash reverse shell via /dev/tcp' },
  { pattern: /\/dev\/tcp\/[^\s]+\/\d+/i, id: 'net_dev_tcp', severity: 'high', category: 'network', description: '/dev/tcp/host/port (network redirect)' },
  { pattern: /python\s+-c\s+['"`][^'"`]*socket\.socket[^'"`]*connect/i, id: 'net_python_revshell', severity: 'critical', category: 'network', description: 'python reverse shell' },
  { pattern: /perl\s+-e\s+['"`][^'"`]*socket[^'"`]*connect/i, id: 'net_perl_revshell', severity: 'critical', category: 'network', description: 'perl reverse shell' },
  { pattern: /msfvenom\s+|metasploit/i, id: 'net_msf', severity: 'critical', category: 'network', description: 'metasploit/msfvenom' },
  { pattern: /\bsudo\s+iptables\b|\bufw\s+(allow|disable)/i, id: 'net_firewall_change', severity: 'medium', category: 'network', description: 'changes firewall rules' },

  // ========================================================================
  // PRIVILEGE ESCALATION
  // ========================================================================
  { pattern: /^allowed-tools\s*:/im, id: 'pe_allowed_tools', severity: 'high', category: 'privilege-escalation', description: 'skill pre-approves tool access' },
  { pattern: /\bsudo\s+-c\b|\bsudo\s+su\b|\bsu\s+-c\b/i, id: 'pe_sudo_dash_c', severity: 'high', category: 'privilege-escalation', description: 'sudo/su -c' },
  { pattern: /\bsudo\s+(rm|chmod|chown|cp|mv|tee|dd|kill)/i, id: 'pe_sudo_destr', severity: 'high', category: 'privilege-escalation', description: 'sudo + destructive utility' },
  { pattern: /NOPASSWD\s*:/i, id: 'pe_nopasswd', severity: 'critical', category: 'privilege-escalation', description: 'passwordless sudoers entry' },
  { pattern: /setuid\s*\(\s*0\s*\)|setgid\s*\(\s*0\s*\)/, id: 'pe_setuid_zero', severity: 'critical', category: 'privilege-escalation', description: 'setuid(0) — root' },
  { pattern: /CAP_SYS_ADMIN|CAP_NET_ADMIN/, id: 'pe_caps', severity: 'high', category: 'privilege-escalation', description: 'requests dangerous capabilities' },

  // ========================================================================
  // CREDENTIAL EXPOSURE (hardcoded secrets in skill content)
  // ========================================================================
  { pattern: /(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}["']/i, id: 'cred_hardcoded', severity: 'critical', category: 'credential-exposure', description: 'hardcoded credential' },
  { pattern: /-----BEGIN\s+(RSA\s+|OPENSSH\s+|EC\s+|DSA\s+|PGP\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/, id: 'cred_priv_key', severity: 'critical', category: 'credential-exposure', description: 'embedded private key' },
  { pattern: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}|gho_[A-Za-z0-9]{36}/, id: 'cred_github_pat', severity: 'critical', category: 'credential-exposure', description: 'GitHub PAT' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{90,}/, id: 'cred_anthropic', severity: 'critical', category: 'credential-exposure', description: 'Anthropic API key' },
  { pattern: /sk-[A-Za-z0-9]{40,}/, id: 'cred_openai', severity: 'critical', category: 'credential-exposure', description: 'OpenAI-style API key' },
  { pattern: /AKIA[0-9A-Z]{16}/, id: 'cred_aws_akid', severity: 'critical', category: 'credential-exposure', description: 'AWS access key ID' },
  { pattern: /AIza[0-9A-Za-z\-_]{35}/, id: 'cred_gcp', severity: 'critical', category: 'credential-exposure', description: 'GCP API key' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, id: 'cred_slack', severity: 'critical', category: 'credential-exposure', description: 'Slack token' },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, id: 'cred_jwt', severity: 'high', category: 'credential-exposure', description: 'JWT (may contain claims)' },

  // ========================================================================
  // MINING
  // ========================================================================
  { pattern: /xmrig|stratum\+tcp|monero|coinhive|cryptonight|nicehash|minergate/i, id: 'mining_ref', severity: 'critical', category: 'mining', description: 'crypto mining reference' },
];

export const PATTERN_COUNT = SECURITY_PATTERNS.length;

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function maxSeverity(findings: { severity: Severity }[]): Severity {
  let max: Severity = 'low';
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[max]) max = f.severity;
  }
  return max;
}
