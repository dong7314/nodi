import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  LogIn,
  UserPlus,
  X,
} from "lucide-react";
import {
  loginLocalAccount,
  readLastLocalAuthEmail,
  registerLocalAccount,
  type LocalAuthUser,
} from "./account-store";

export type AuthDialogMode = "login" | "signup";

type AuthDialogProps = {
  initialMode: AuthDialogMode;
  onPrepareAuthentication: () => void;
  onAuthenticationFinished: () => void;
  onAuthenticated: (user: LocalAuthUser) => void;
  onClose: () => void;
};

export function AuthDialog({
  initialMode,
  onPrepareAuthentication,
  onAuthenticationFinished,
  onAuthenticated,
  onClose,
}: AuthDialogProps) {
  const [mode, setMode] = useState<AuthDialogMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(readLastLocalAuthEmail);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const submittingRef = useRef(false);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const closeTimerRef = useRef<number | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);

  const title = mode === "login" ? "Nodi에 로그인" : "로컬 계정 만들기";
  const description = mode === "login"
    ? "로그인하면 공유, 댓글, 검색과 워크스페이스\n설정을 모두 사용할 수 있어요."
    : "이 기기에 계정을 만들고 관리자 승인 후\nNodi의 전체 기능을 사용하세요.";
  const formValid = useMemo(() => (
    mode === "login"
      ? Boolean(email.trim() && password.length >= 8)
      : Boolean(
          name.trim().length >= 2
          && email.trim()
          && password.length >= 8
          && password === passwordConfirmation,
        )
  ), [email, mode, name, password, passwordConfirmation]);

  const closeWithAnimation = useCallback(() => {
    if (closingRef.current || submittingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 150);
  }, [onClose]);

  const switchMode = (nextMode: AuthDialogMode) => {
    if (submittingRef.current || closingRef.current) return;
    setMode(nextMode);
    setFeedback(null);
    setPassword("");
    setPasswordConfirmation("");
  };

  const submit = async () => {
    if (!formValid || submittingRef.current || closingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    let awaitingReload = false;
    try {
      const prepare = () => {
        if (!mountedRef.current) throw new Error("인증 창이 닫혔어요. 다시 시도해 주세요.");
        onPrepareAuthentication();
      };
      // Check before sending credentials and again before replacing the guest
      // cache: an attachment may have completed while the request was pending.
      prepare();
      const result = mode === "login"
        ? await loginLocalAccount(email, password, prepare)
        : await registerLocalAccount({ name, email, password }, prepare);
      if (!mountedRef.current) return;
      if (!result.ok) {
        setFeedback({ kind: "error", message: result.message });
        return;
      }
      if (result.user) {
        awaitingReload = true;
        setFeedback({ kind: "success", message: result.message });
        successTimerRef.current = window.setTimeout(() => onAuthenticated(result.user!), 240);
        return;
      }
      setFeedback({ kind: "success", message: result.message });
      setMode("login");
      setPassword("");
      setPasswordConfirmation("");
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "로그인을 준비하지 못했어요. 다시 시도해 주세요." });
    } finally {
      if (!awaitingReload) {
        submittingRef.current = false;
        setSubmitting(false);
        onAuthenticationFinished();
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWithAnimation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeWithAnimation]);

  return createPortal(
    <div className={`auth-layer ${isClosing ? "is-closing" : ""}`} role="presentation">
      <button
        type="button"
        className="auth-backdrop"
        aria-label="인증 창 바깥 영역 닫기"
        disabled={submitting}
        onClick={closeWithAnimation}
      />
      <section
        className={`auth-dialog ${isClosing ? "is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
      >
        <button type="button" className="auth-close" aria-label="인증 창 닫기" disabled={submitting} onClick={closeWithAnimation}>
          <X size={17} />
        </button>

        <header className="auth-heading">
          <span className="auth-brand-mark">N</span>
          <span className="auth-eyebrow">{mode === "login" ? "다시 만나서 반가워요" : "나만의 생각 공간"}</span>
          <h1 id="auth-dialog-title">{title}</h1>
          <p>{description}</p>
        </header>

        <div className="auth-tabs" role="tablist" aria-label="인증 방식">
          <button
            type="button"
            role="tab"
            disabled={submitting}
            aria-selected={mode === "login"}
            className={mode === "login" ? "is-active" : ""}
            onClick={() => switchMode("login")}
          >
            로그인
          </button>
          <button
            type="button"
            role="tab"
            disabled={submitting}
            aria-selected={mode === "signup"}
            className={mode === "signup" ? "is-active" : ""}
            onClick={() => switchMode("signup")}
          >
            회원가입
          </button>
        </div>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === "signup" && (
            <label>
              <span>이름</span>
              <input
                autoFocus
                value={name}
                disabled={submitting}
                autoComplete="name"
                maxLength={40}
                placeholder="Nodi에서 사용할 이름"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <label>
            <span>이메일</span>
            <input
              autoFocus={mode === "login"}
              type="email"
              value={email}
              disabled={submitting}
              autoComplete="email"
              placeholder="name@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>비밀번호</span>
            <span className="auth-password-field">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                disabled={submitting}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder="8자 이상"
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </span>
          </label>
          {mode === "signup" && (
            <label>
              <span>비밀번호 확인</span>
              <input
                type={showPassword ? "text" : "password"}
                value={passwordConfirmation}
                disabled={submitting}
                autoComplete="new-password"
                placeholder="비밀번호를 다시 입력"
                onChange={(event) => setPasswordConfirmation(event.target.value)}
              />
            </label>
          )}

          {feedback && (
            <div className={`auth-feedback is-${feedback.kind}`} role="status">
              {feedback.kind === "success" ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}
              <span>{feedback.message}</span>
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={!formValid || submitting}>
            {mode === "login" ? <LogIn size={16} /> : <UserPlus size={16} />}
            <span>{submitting ? "확인 중…" : mode === "login" ? "로그인" : "회원가입 요청"}</span>
          </button>
        </form>

        {mode === "login" && (
          <div className="auth-local-note">
            <span><HardDrive size={15} /></span>
            <div>
              <strong>로그인하지 않아도 메모할 수 있어요.</strong>
              <small>게스트 메모는 이 브라우저의 localStorage에만 보관됩니다.</small>
            </div>
          </div>
        )}

      </section>
    </div>,
    document.body,
  );
}
