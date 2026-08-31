import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  Loader2,
  Lock,
  Landmark,
  CreditCard,
  Smartphone,
  User,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import {
  fetchKycStatus,
  submitKycDetails,
  requestPennyDrop,
  verifyPennyDrop,
  describeBankNameProblem,
  describeIfscProblem,
  describeAccountProblem,
  describeUpiProblem,
} from '../services/kyc';
import { ApiRequestError, NetworkError } from '../services/apiClient';

/**
 * Vendor verification.
 *
 * Three stages, mirroring the server's state machine:
 *   draft       -> collect bank details and a UPI ID
 *   penny_sent  -> confirm the exact amount that landed in the account
 *   verified    -> catalog writes unlocked
 *
 * The amount is randomised and under ₹1. Asking for the exact figure rather than
 * a "did you receive it?" button is the whole point: only someone who can see
 * the account's statement can answer, which is what proves they control it.
 *
 * Nothing here decides whether the vendor is verified. `canUpdateStock` comes
 * from the server, and the API re-checks it on every catalog write.
 */
export default function VendorKycModal({ onVerified, onClose, allowDismiss = true }) {
  const [kyc, setKyc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const [legalName, setLegalName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [upiVpa, setUpiVpa] = useState('');

  // Entered in rupees, because that is how a bank statement shows it.
  const [amountRupees, setAmountRupees] = useState('');

  const describeError = (err, fallback) => {
    if (err instanceof NetworkError) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (err instanceof ApiRequestError) return err.message;
    return fallback;
  };

  const refresh = useCallback(async () => {
    try {
      const status = await fetchKycStatus();
      setKyc(status);
    } catch (err) {
      setError(describeError(err, 'Could not load your verification status.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSubmitDetails = async (e) => {
    e.preventDefault();
    if (isBusy) return;

    // Advisory checks only; the server enforces the authoritative rules.
    const problem =
      (!legalName.trim() && 'Enter the name on the bank account.') ||
      describeBankNameProblem(bankName) ||
      describeAccountProblem(bankAccount) ||
      describeIfscProblem(ifsc) ||
      describeUpiProblem(upiVpa);

    if (problem) {
      setError(problem);
      return;
    }

    setError('');
    setIsBusy(true);
    try {
      const updated = await submitKycDetails({
        legalName: legalName.trim(),
        bankName: bankName.trim(),
        bankAccount: bankAccount.trim(),
        ifsc: ifsc.trim().toUpperCase(),
        upiVpa: upiVpa.trim().toLowerCase(),
      });
      setKyc(updated);
      // The details are stored; move straight on to proving account control.
      await handleSendPennyDrop();
    } catch (err) {
      setError(describeError(err, 'Could not save those details. Please try again.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSendPennyDrop = async () => {
    setError('');
    setIsBusy(true);
    try {
      const updated = await requestPennyDrop();
      setKyc(updated);
      setAmountRupees('');
    } catch (err) {
      setError(describeError(err, 'Could not send the verification transfer.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleVerifyAmount = async (e) => {
    e.preventDefault();
    if (isBusy) return;

    const paise = Math.round(Number.parseFloat(amountRupees) * 100);
    if (!Number.isFinite(paise) || paise <= 0) {
      setError('Enter the exact amount you received, e.g. 0.47');
      return;
    }

    setError('');
    setIsBusy(true);
    try {
      const updated = await verifyPennyDrop(paise);
      setKyc(updated);
      onVerified?.(updated);
    } catch (err) {
      setError(describeError(err, 'Could not verify that amount.'));
      // A rejected record has to start over from the details form.
      if (err instanceof ApiRequestError && err.code === 'PENNY_DROP_ATTEMPTS_EXCEEDED') {
        refresh();
      }
    } finally {
      setIsBusy(false);
    }
  };

  const stage = isLoading ? 'loading' : kyc?.status === 'verified' ? 'verified' : kyc?.status === 'penny_sent' ? 'confirm' : 'details';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl border border-gray-100 relative overflow-y-auto max-h-[92dvh] animate-scale-in">
        {/* Header */}
        <div className="bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] p-5 text-white sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-white/10 flex items-center justify-center border border-white/10 shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-extrabold text-base tracking-tight">Verify Your Account</h3>
              <p className="text-[12.5px] text-emerald-200/80 font-bold">
                Required before you can list or update stock
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {stage === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-10 text-gray-500 text-xs font-bold">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading your verification status…</span>
            </div>
          )}

          {/* ---------------------------------------------------------------- */}
          {stage === 'details' && (
            <form onSubmit={handleSubmitDetails} className="space-y-3.5 text-xs">
              {kyc?.status === 'rejected' && (
                <div className="bg-rose-50 p-3 rounded-2xl border border-rose-200 flex gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                  <p className="text-[12.5px] text-rose-900 font-semibold leading-relaxed">
                    {kyc.rejectionReason || 'Verification was declined.'} Check your details and try again.
                  </p>
                </div>
              )}

              <div>
                <label className="block font-bold text-gray-800 mb-1">Bank Account Name</label>
                <div className="relative">
                  <input
                    type="text"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="e.g. Ramesh Kumar"
                    maxLength={120}
                    className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                    required
                    disabled={isBusy}
                  />
                  <User className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                </div>
              </div>

              <div>
                <label className="block font-bold text-gray-800 mb-1">Bank Account Number</label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, '').slice(0, 18))}
                    placeholder="9 to 18 digits"
                    className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-mono font-semibold tracking-wider text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                    required
                    disabled={isBusy}
                  />
                  <Landmark className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                </div>
              </div>

              <div>
                <label className="block font-bold text-gray-800 mb-1">Bank Name</label>
                <div className="relative">
                  <input
                    type="text"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value.slice(0, 120))}
                    placeholder="e.g. HDFC Bank"
                    maxLength={120}
                    className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                    required
                    disabled={isBusy}
                  />
                  <CreditCard className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                </div>
              </div>

              <div>
                <label className="block font-bold text-gray-800 mb-1">IFSC Code</label>
                <div className="relative">
                  <input
                    type="text"
                    value={ifsc}
                    onChange={(e) => setIfsc(e.target.value.toUpperCase().slice(0, 11))}
                    placeholder="HDFC0001234"
                    maxLength={11}
                    className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-mono font-semibold tracking-wider text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                    required
                    disabled={isBusy}
                  />
                  <Landmark className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                </div>
              </div>

              <div>
                <label className="block font-bold text-gray-800 mb-1">UPI ID</label>
                <div className="relative">
                  <input
                    type="text"
                    value={upiVpa}
                    onChange={(e) => setUpiVpa(e.target.value.toLowerCase())}
                    placeholder="name@bank"
                    maxLength={100}
                    className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                    required
                    disabled={isBusy}
                  />
                  <Smartphone className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                </div>
                <p className="text-[11.5px] text-gray-500 font-semibold mt-1.5 leading-relaxed">
                  We will send a small amount (under ₹1) to this UPI ID. You will need to tell us the
                  exact amount you received.
                </p>
              </div>

              <div className="bg-gray-50 p-3 rounded-2xl border border-gray-200 flex gap-2">
                <Lock className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
                <p className="text-[11.5px] text-gray-600 font-semibold leading-relaxed">
                  Your account number is encrypted and never shown in full again — only the last four
                  digits.
                </p>
              </div>

              {error && <p className="text-[12.5px] font-bold text-rose-600">{error}</p>}

              <button
                type="submit"
                disabled={isBusy}
                className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3.5 rounded-2xl transition-all shadow-md flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                <span>{isBusy ? 'Sending verification…' : 'Submit & Send ₹1 Verification'}</span>
              </button>
            </form>
          )}

          {/* ---------------------------------------------------------------- */}
          {stage === 'confirm' && (
            <form onSubmit={handleVerifyAmount} className="space-y-4 text-xs">
              <div className="bg-blue-50/80 p-4 rounded-2xl border border-blue-100 space-y-1.5">
                <div className="flex items-center gap-2 text-blue-900 font-extrabold text-xs">
                  <Smartphone className="w-4 h-4 text-blue-700" />
                  <span>Check your UPI account</span>
                </div>
                <p className="text-[12.5px] text-blue-800 leading-relaxed font-semibold">
                  We sent a small amount to <span className="font-mono">{kyc?.upiVpa}</span>. Open your
                  banking or UPI app, find the credit from VegDrop, and enter the exact amount below.
                </p>
              </div>

              <div>
                <label className="block font-bold text-gray-800 mb-1">Exact amount received (₹)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountRupees}
                  onChange={(e) => setAmountRupees(e.target.value.replace(/[^\d.]/g, '').slice(0, 6))}
                  placeholder="e.g. 0.47"
                  className="w-full bg-white border border-gray-300 rounded-2xl py-3 px-4 text-center text-lg font-mono font-bold tracking-widest text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                  required
                  autoFocus
                  disabled={isBusy}
                />
                {kyc?.pennyDrop?.attemptsRemaining != null && (
                  <p className="text-[11.5px] text-gray-500 font-semibold mt-1.5">
                    {kyc.pennyDrop.attemptsRemaining} attempt
                    {kyc.pennyDrop.attemptsRemaining === 1 ? '' : 's'} remaining.
                  </p>
                )}
              </div>

              {error && <p className="text-[12.5px] font-bold text-rose-600">{error}</p>}

              <button
                type="submit"
                disabled={isBusy}
                className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3.5 rounded-2xl transition-all shadow-md flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                <span>{isBusy ? 'Verifying…' : 'Confirm Amount & Unlock Stock'}</span>
              </button>

              <button
                type="button"
                onClick={handleSendPennyDrop}
                disabled={isBusy}
                className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2.5 rounded-2xl text-[12.5px] transition-colors cursor-pointer active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Didn't receive it? Send again</span>
              </button>
            </form>
          )}

          {/* ---------------------------------------------------------------- */}
          {stage === 'verified' && (
            <div className="space-y-4 text-xs text-center py-4">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto border border-emerald-200">
                <CheckCircle2 className="w-8 h-8 text-emerald-700" />
              </div>
              <div className="space-y-1">
                <h4 className="font-extrabold text-gray-900 text-base">Account Verified</h4>
                <p className="text-[12.5px] text-gray-600 font-semibold leading-relaxed">
                  You can now list products and update stock.
                </p>
              </div>

              <div className="bg-gray-50 p-3 rounded-2xl border border-gray-200 text-left space-y-1.5">
                <Row label="Name" value={kyc?.legalName} />
                <Row label="Bank" value={kyc?.bankName} />
                <Row label="Bank account" value={kyc?.bankAccount} />
                <Row label="UPI ID" value={kyc?.upiVpa} />
              </div>

              <button
                type="button"
                onClick={onClose}
                className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3.5 rounded-2xl transition-all shadow-md text-xs cursor-pointer active:scale-98"
              >
                Continue to Dashboard
              </button>
            </div>
          )}

          {/* A vendor who has not finished cannot dismiss this into a panel whose
              controls would only fail server-side anyway. */}
          {allowDismiss && stage !== 'verified' && stage !== 'loading' && (
            <button
              type="button"
              onClick={onClose}
              className="w-full text-gray-500 hover:text-gray-700 font-bold py-2 text-[12.5px] cursor-pointer"
            >
              I'll do this later
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11.5px] text-gray-500 uppercase font-bold tracking-wide">{label}</span>
      <span className="text-[12.5px] font-mono font-bold text-gray-900 truncate">{value || '—'}</span>
    </div>
  );
}
