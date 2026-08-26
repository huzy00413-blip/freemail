from __future__ import annotations

import sys
from pathlib import Path


path = Path(sys.argv[1]).resolve() / "rebind_core" / "mfa_login.py"
text = path.read_text(encoding="utf-8")

if "initial_need_email_otp =" in text:
    raise SystemExit(0)

needle = '    if page_type != "login_password" and "/log-in/password" not in (continue_url or ""):\n'
if text.count(needle) != 1:
    raise SystemExit(f"expected one initial login guard in {path}")

block = '''    # 账号也可能在密码页之前要求旧邮箱验证码。
    # 只有登录状态明确为 email_otp_verification 时才读取旧邮箱。
    email_otp_resp: dict[str, Any] = {}
    initial_need_email_otp = page_type == "email_otp_verification" or "/email-verification" in (continue_url or "")
    if initial_need_email_otp:
        if not otp_mail_api:
            raise MfaLoginError("EMAIL_OTP_FAILED", "登录要求旧邮箱验证码，但未配置收信 API")
        otp_sent_at = time.time()
        try:
            if hasattr(auth, "_is_existing_account"):
                auth._is_existing_account = True
            kickoff = getattr(auth, "kickoff_otp_delivery", None)
            delivered = bool(kickoff("rebind_login_initial_otp")) if callable(kickoff) else False
            if not delivered:
                send_otp = getattr(auth, "send_otp", None)
                if not callable(send_otp):
                    raise RuntimeError("上游未提供邮箱验证码发送方法")
                send_otp(referer="https://auth.openai.com/email-verification")
                otp_sent_at = time.time()
            email_code = wait_code(
                otp_mail_api,
                issued_after=otp_sent_at - 5,
                timeout=max(30.0, float(mail_timeout or 120.0)),
            )
            email_otp_resp = auth.verify_otp(email_code)
            sess.trace.append({"step": "email_otp_verify", "mailbox": "configured"})
        except TimeoutError as exc:
            raise MfaLoginError("EMAIL_OTP_FAILED", str(exc)) from exc
        except MfaLoginError:
            raise
        except Exception as exc:
            raise MfaLoginError("EMAIL_OTP_FAILED", f"旧邮箱验证码校验失败: {str(exc)[:240]}") from exc

        continue_url = auth._normalize_continue_url(
            auth._extract_continue_url_from_step(email_otp_resp) or continue_url
        )
        page_type = (auth._extract_page_type(email_otp_resp) or "").lower()

'''
text = text.replace(needle, block + needle, 1)

old = '    email_otp_resp: dict[str, Any] = {}\n    need_email_otp = page_type == "email_otp_verification" or "/email-verification" in (continue_url or "")\n'
if text.count(old) == 1:
    text = text.replace(
        old,
        '    need_email_otp = page_type == "email_otp_verification" or "/email-verification" in (continue_url or "")\n',
        1,
    )
elif text.count('    need_email_otp = page_type == "email_otp_verification" or "/email-verification" in (continue_url or "")\n') != 1:
    raise SystemExit(f"expected one post-password OTP block in {path}")
path.write_text(text, encoding="utf-8")
