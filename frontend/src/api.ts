export class ApiError extends Error {
  constructor(
    public category: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.category ?? "network",
      value.error?.message ?? "The operation could not finish.",
      response.status,
    );
  return value as T;
}
export function upload(
  lectureId: string,
  file: File,
  onProgress: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/lectures/" + lectureId + "/audio");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress((event.loaded / event.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = "Upload failed.";
        try {
          message = JSON.parse(xhr.responseText).error.message;
        } catch {
          /* server/proxy may return HTML */
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () =>
      reject(
        new Error(
          "Upload connection lost. Refresh the library to check whether the original was saved.",
        ),
      );
    const data = new FormData();
    data.append("file", file);
    xhr.send(data);
  });
}
export function time(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return (
    (seconds >= 3600
      ? String(Math.floor(seconds / 3600)).padStart(2, "0") + ":"
      : "") +
    String(Math.floor(seconds / 60) % 60).padStart(2, "0") +
    ":" +
    String(seconds % 60).padStart(2, "0")
  );
}
export function money(micros: number | null, currency: string | null) {
  return micros === null
    ? "Unknown"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: currency ?? "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(micros / 1e6);
}
export function bytes(size: number) {
  return (
    new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(
      size / 1024 / 1024,
    ) + " MB"
  );
}
