import Icon from "./Icon";

export type StepState = "idle" | "checking" | "signing" | "confirming" | "done" | "error";

const steps = [
  { key: "check", label: "1. Kiểm tra L1" },
  { key: "sign", label: "2. Ký ví Core" },
  { key: "confirm", label: "3. Biên nhận" },
] as const;

function stepStatus(
  index: number,
  state: StepState,
  errorStep: 0 | 1 | 2,
): "done" | "active" | "error" | "upcoming" {
  if (state === "done") return "done";
  if (state === "error") {
    if (index < errorStep) return "done";
    if (index === errorStep) return "error";
    return "upcoming";
  }
  const activeIndex =
    state === "checking" ? 0 : state === "signing" ? 1 : state === "confirming" ? 2 : -1;
  if (activeIndex < 0) return "upcoming";
  if (index < activeIndex) return "done";
  if (index === activeIndex) return "active";
  return "upcoming";
}

export default function TransactionStepper({
  state,
  errorStep = 0,
}: {
  state: StepState;
  errorStep?: 0 | 1 | 2;
}) {
  if (state === "idle") return null;
  const inProgress = state === "checking" || state === "signing" || state === "confirming";
  return (
    <div className={`tx-stepper-shell ${inProgress ? "tx-stepper-busy" : ""}`}>
      <ol className="tx-stepper" aria-label="Tiến trình giao dịch">
        {steps.map((step, index) => {
          const status = stepStatus(index, state, errorStep);
          return (
            <li key={step.key} className={`tx-step tx-step-${status}`}>
              <span className="tx-step-indicator tabular-nums" aria-hidden="true">
                {status === "done" ? <Icon name="check" /> : <span>{index + 1}</span>}
              </span>
              <span className="tx-step-label">{step.label}</span>
            </li>
          );
        })}
      </ol>
      {inProgress ? (
        <div className="l1-shimmer-track" aria-hidden="true">
          <div className="l1-shimmer-bar" />
        </div>
      ) : null}
    </div>
  );
}
