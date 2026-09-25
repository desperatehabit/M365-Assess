import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

export { loadConfig, type BffConfig } from "./config.js";
export { buildServer, OPENAPI_ROUTE, type BuildServerOptions, type Route, type RouteHandler } from "./server.js";
export { AppError, ErrorCodes, toErrorBody, type ErrorBody, type ErrorDetail } from "./errors.js";
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  clampLimit,
  decodeCursor,
  encodeCursor,
  paginate,
  parsePagination,
  type CursorPage,
  type Pagination,
} from "./pagination.js";

const config = loadConfig();
const server = buildServer();

server.listen(config.port, config.host, () => {
  console.log(`M365-Assess BFF listening on http://${config.host}:${config.port}`);
});
