'use strict';
// Lending ledger settlement (FR-26): in kind (linked delivery) or at landed cost (marked paid).
const audit = require('./audit');
const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });

async function settleLoan(loanId, { mode, settlementTransfer, reference }, actor, userHospital) {
  const loan = await SELECT.one.from('medilink.Ledger').where({ ID: loanId });
  if (!loan) throw err(404, 'LOAN_NOT_FOUND', loanId);
  if (userHospital && ![loan.lender_ID, loan.borrower_ID].includes(userHospital)) throw err(403, 'NOT_A_PARTY', 'Only the lender or borrower can settle this loan');
  if (loan.status !== 'OPEN') throw err(409, 'LOAN_NOT_OPEN', `Loan is ${loan.status}`);
  mode = String(mode || loan.repaymentMode).toUpperCase();
  let ref, amount = 0, ownLoan = null;
  if (mode === 'IN_KIND') {
    if (!settlementTransfer) throw err(400, 'SETTLEMENT_TRANSFER_REQUIRED', 'In-kind settlement must link the repayment delivery');
    const t = await SELECT.one.from('medilink.Transfers').where({ ID: settlementTransfer });
    if (!t || t.status !== 'DELIVERED') throw err(409, 'REPAYMENT_NOT_DELIVERED', 'The linked repayment transfer must be DELIVERED');
    if (t.supplier_ID !== loan.borrower_ID || t.receiver_ID !== loan.lender_ID) throw err(409, 'REPAYMENT_WRONG_PARTIES', 'Repayment must go from the borrower to the lender');
    if (t.drug_ID !== loan.drug_ID) throw err(409, 'REPAYMENT_WRONG_DRUG', 'Repayment must be the same drug');
    if (Number(t.qtyReceived ?? t.qty) < Number(loan.qty)) throw err(409, 'REPAYMENT_SHORT', `Repayment ${t.qtyReceived ?? t.qty} is less than the loan ${loan.qty}`);
    ref = 'TRANSFER:' + t.ID;
    // one delivery repays one loan, once; if it was accepted as an ordinary loan, that reverse loan is withdrawn (never both)
    ownLoan = await SELECT.one.from('medilink.Ledger').where({ transfer_ID: t.ID });
    const used = (t.repaysLoan_ID && t.repaysLoan_ID !== loan.ID) || ownLoan?.status === 'SETTLED' || await SELECT.one.from('medilink.Ledger').columns('ID').where({ settlementRef: ref });
    if (used) throw err(409, 'REPAYMENT_ALREADY_USED', 'This delivery already repaid or paid for another loan');
  } else if (mode === 'LANDED_COST') {
    if (!reference) throw err(400, 'PAYMENT_REFERENCE_REQUIRED', 'Landed-cost settlement needs a payment reference');
    ref = 'PAID:' + reference;
    amount = Number(loan.landedCost);
  } else throw err(400, 'INVALID_MODE', 'mode must be IN_KIND or LANDED_COST');
  if (!await UPDATE('medilink.Ledger').set({ status: 'SETTLED', repaymentMode: mode, settledAt: new Date().toISOString(), settlementRef: ref }).where({ ID: loanId, status: 'OPEN' })) throw err(409, 'LOAN_NOT_OPEN', 'Loan was settled meanwhile');
  if (mode === 'IN_KIND') {
    await UPDATE('medilink.Transfers').set({ repaysLoan_ID: loanId }).where({ ID: settlementTransfer });
    if (ownLoan?.status === 'OPEN') await UPDATE('medilink.Ledger').set({ status: 'CANCELLED', settlementRef: 'REPAYS:' + loanId }).where({ ID: ownLoan.ID, status: 'OPEN' });
  }
  await audit.log(actor, 'LEDGER_SETTLED', { loan: loanId, mode, ref, amount, reverseLoanCancelled: ownLoan?.status === 'OPEN' ? ownLoan.ID : undefined });
  return { loanId, status: 'SETTLED', mode, amount };
}
module.exports = { settleLoan };
