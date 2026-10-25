import { useCallback, useState } from "react";

export type ComputePreference = "GPU" | "CPU";

const KEY = "fern-compute-preference:v1";

function loadPreference(): { allowCpu: boolean; device: ComputePreference } {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
      allowCpu?: unknown;
      device?: unknown;
    } | null;
    const allowCpu = parsed?.allowCpu === true;
    const requested = parsed?.device === "CPU" ? "CPU" : "GPU";
    return { allowCpu, device: allowCpu ? requested : "GPU" };
  } catch {
    return { allowCpu: false, device: "GPU" };
  }
}

export function useComputePreference() {
  const [preference, setPreference] = useState(loadPreference);

  const updatePreference = useCallback(
    (patch: Partial<typeof preference>) => {
      setPreference((current) => {
        const allowCpu = patch.allowCpu ?? current.allowCpu;
        const requested = patch.device ?? current.device;
        const next = {
          allowCpu,
          device: (allowCpu ? requested : "GPU") as ComputePreference,
        };
        try {
          localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          // Keep the in-session choice if local storage is unavailable.
        }
        return next;
      });
    },
    [],
  );

  return { ...preference, updatePreference };
}
