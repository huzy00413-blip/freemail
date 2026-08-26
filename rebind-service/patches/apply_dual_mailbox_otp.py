from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(sys.argv[1]).resolve()


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path.name}, got {count}")
    path.write_text(text.replace(old, new), encoding="utf-8")


mfa = ROOT / "rebind_core" / "mfa_login.py"
replace_once(
    mfa,
    "from registration_core.mfa_totp_protocol import totp_code_candidates  # noqa: E402\n",
    "from registration_core.mfa_totp_protocol import totp_code_candidates  # noqa: E402\n"
    "from .mail_inbox import wait_code\n",
)
replace_once(
    mfa,
    "    proxy: str | None = None,\n) -> LoginSession:\n"
    "    \"\"\"账密 + TOTP 纯协议登录，返回可用 session/AT。\"\"\"\n",
    "    proxy: str | None = None,\n"
    "    mail_api: str | None = None,\n"
    "    email_otp_mail_api: str | None = None,\n"
    "    mail_timeout: float = 120.0,\n"
    ") -> LoginSession:\n"
    "    \"\"\"账密 + 邮箱 OTP（若登录响应要求）+ TOTP 纯协议登录。\"\"\"\n",
)
replace_once(
    mfa,
    "    totp_secret = (totp_secret or \"\").strip().replace(\" \", \"\").upper()\n"
    "    if not email or not password or not totp_secret:\n",
    "    totp_secret = (totp_secret or \"\").strip().replace(\" \", \"\").upper()\n"
    "    otp_mail_api = (email_otp_mail_api or mail_api or \"\").strip()\n"
    "    if not email or not password or not totp_secret:\n",
)
replace_once(
    mfa,
    "    # 4) resolve factor id\n"
    "    client_auth = _parse_client_auth_session(_cookie_value(auth.session, \"oai-client-auth-session\"))\n"
    "    factor_id = extract_factor_id(continue_url, pwd_resp, client_auth)\n",
    "    # 某些账号在密码校验后会进入 email_otp_verification。\n"
    "    # 只有服务端明确返回该状态时才收取邮箱验证码，不猜测验证码顺序。\n"
    "    email_otp_resp: dict[str, Any] = {}\n"
    "    need_email_otp = page_type == \"email_otp_verification\" or \"/email-verification\" in (continue_url or \"\")\n"
    "    if need_email_otp:\n"
    "        if not otp_mail_api:\n"
    "            raise MfaLoginError(\"EMAIL_OTP_FAILED\", \"登录要求邮箱验证码，但未配置对应收信 API\")\n"
    "        otp_sent_at = time.time()\n"
    "        try:\n"
    "            # 这是已有账号登录，不要把 passwordless/send-otp 当成注册流程。\n"
    "            # 上游已有账号策略会优先复用当前 challenge 并调用 resend。\n"
    "            if hasattr(auth, \"_is_existing_account\"):\n"
    "                auth._is_existing_account = True\n"
    "            kickoff = getattr(auth, \"kickoff_otp_delivery\", None)\n"
    "            delivered = bool(kickoff(\"rebind_login_need_otp\")) if callable(kickoff) else False\n"
    "            if not delivered:\n"
    "                send_otp = getattr(auth, \"send_otp\", None)\n"
    "                if not callable(send_otp):\n"
    "                    raise RuntimeError(\"上游未提供邮箱验证码发送方法\")\n"
    "                send_otp(referer=\"https://auth.openai.com/email-verification\")\n"
    "                otp_sent_at = time.time()\n"
    "            email_code = wait_code(\n"
    "                otp_mail_api,\n"
    "                issued_after=otp_sent_at - 5,\n"
    "                timeout=max(30.0, float(mail_timeout or 120.0)),\n"
    "            )\n"
    "            email_otp_resp = auth.verify_otp(email_code)\n"
    "            sess.trace.append({\"step\": \"email_otp_verify\", \"mailbox\": \"configured\"})\n"
    "        except TimeoutError as exc:\n"
    "            raise MfaLoginError(\"EMAIL_OTP_FAILED\", str(exc)) from exc\n"
    "        except MfaLoginError:\n"
    "            raise\n"
    "        except Exception as exc:\n"
    "            raise MfaLoginError(\"EMAIL_OTP_FAILED\", f\"邮箱验证码校验失败: {str(exc)[:240]}\") from exc\n"
    "\n"
    "        continue_url = auth._normalize_continue_url(\n"
    "            auth._extract_continue_url_from_step(email_otp_resp) or continue_url\n"
    "        )\n"
    "        page_type = (auth._extract_page_type(email_otp_resp) or \"\").lower()\n"
    "\n"
    "    # 4) resolve factor id\n"
    "    client_auth = _parse_client_auth_session(_cookie_value(auth.session, \"oai-client-auth-session\"))\n"
    "    factor_id = extract_factor_id(continue_url, pwd_resp, email_otp_resp, client_auth)\n",
)
replace_once(
    mfa,
    "        factor_id = extract_factor_id((pwd_resp or {}).get(\"page\") if isinstance(pwd_resp, dict) else None)\n"
    "    if not factor_id:\n        raise MfaLoginError(\"MFA_FAILED\", \"password/verify 后未解析到 totp factor_id\")\n",
    "        factor_id = extract_factor_id((pwd_resp or {}).get(\"page\") if isinstance(pwd_resp, dict) else None)\n"
    "    if not factor_id:\n"
    "        factor_id = extract_factor_id((email_otp_resp or {}).get(\"page\") if isinstance(email_otp_resp, dict) else None)\n"
    "    if not factor_id:\n        raise MfaLoginError(\"MFA_FAILED\", \"password/verify 后未解析到 totp factor_id\")\n",
)

pipeline = ROOT / "rebind_core" / "pipeline.py"
replace_once(pipeline, "    mail_api: str,\n", "    mail_api: str | None = None,\n    old_mail_api: str | None = None,\n    new_mail_api: str | None = None,\n")
replace_once(
    pipeline,
    "    mail_api = (mail_api or \"\").strip()\n",
    "    old_mail_api = (old_mail_api or mail_api or \"\").strip()\n"
    "    new_mail_api = (new_mail_api or mail_api or \"\").strip()\n",
)
replace_once(
    pipeline,
    "            old_email, password, totp_secret, proxy=proxy\n",
    "            old_email,\n            password,\n            totp_secret,\n            proxy=proxy,\n"
    "            email_otp_mail_api=old_mail_api,\n            mail_timeout=mail_timeout,\n",
)
replace_once(
    pipeline,
    "            code = wait_code(mail_api, issued_after=issued_after - 5, timeout=mail_timeout)\n",
    "            code = wait_code(new_mail_api, issued_after=issued_after - 5, timeout=mail_timeout)\n",
)
replace_once(
    pipeline,
    "                new_email, password, totp_secret, proxy=proxy\n",
    "                new_email,\n                password,\n                totp_secret,\n                proxy=proxy,\n"
    "                email_otp_mail_api=new_mail_api,\n                mail_timeout=mail_timeout,\n",
)
