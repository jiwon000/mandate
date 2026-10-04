// Revert data has to survive the hop or ethers cannot decode the custom error,
// and the whole point of the demo is showing which error the guard raised.
export function toRpcError(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data ?? error?.cause?.data;
  return {
    code: Number.isInteger(error?.code) ? error.code : -32603,
    message: error?.shortMessage ?? error?.message ?? String(error),
    ...(data === undefined ? {} : { data })
  };
}

export const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
export const rpcFailure = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) }
});
