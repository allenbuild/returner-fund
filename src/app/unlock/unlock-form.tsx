"use client";

import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import styles from "./unlock.module.css";

interface UnlockFormProps {
  invalidPassword: boolean;
  returnTo: string;
}

export function UnlockForm({ invalidPassword, returnTo }: UnlockFormProps) {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  return (
    <form action="/api/access/unlock" method="post" className={styles.form}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <label className={styles.srOnly} htmlFor="site-password">Password</label>
      <div className={styles.inputShell}>
        <input
          autoComplete="current-password"
          autoFocus
          id="site-password"
          name="password"
          placeholder="Enter password"
          required
          type={isPasswordVisible ? "text" : "password"}
        />
        <button
          aria-label={isPasswordVisible ? "Hide password" : "Show password"}
          className={styles.revealButton}
          onClick={() => setIsPasswordVisible((visible) => !visible)}
          type="button"
        >
          {isPasswordVisible ? <Eye size={24} strokeWidth={1.8} /> : <EyeOff size={24} strokeWidth={1.8} />}
        </button>
        <button aria-label="Continue" className={styles.submitButton} type="submit">
          <ArrowRight size={25} strokeWidth={1.9} />
        </button>
      </div>
      {invalidPassword ? (
        <p className={styles.error} role="alert">That password didn’t match. Please try again.</p>
      ) : null}
    </form>
  );
}
