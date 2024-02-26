import { GitRepository } from "./GitRepository.mjs";
import { MemoryGitRepository } from "./MemoryGitRepository.mjs";
import { MongoGitRepository } from "./MongoGitRepository.mjs";
import { handlePost, handleGetRefs, ZeroIdStr, debug } from "./protocol.mjs";
const Protocol = { handlePost, handleGetRefs, ZeroIdStr, debug }
export { GitRepository, MemoryGitRepository, MongoGitRepository, Protocol };
