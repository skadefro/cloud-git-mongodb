/*
This file contains original work that is licensed under the MIT License, with copyright (c) 2021 Fusebit.
Modifications made to this file are licensed under the Mozilla Public License 2.0 (MPL-2.0), with copyright (c) 2024 OpenIAP ApS.

The original work is provided under the following license:

MIT License

Copyright (c) 2021 Fusebit

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information on the MPL-2.0 license for the modifications, please see https://github.com/openiap/.github/blob/main/LICENSE.
*/
import { Protocol } from "./index.mjs";

export class GitRepository {
  constructor() {}

  isZeroId(id) {
    return id === Protocol.ZeroIdStr;
  }
  /**
   * Override to implement custom authorization logic, if used <code>createExpress</code> to register routes
    * @param req {import("express").Request}
    * @param res {import("express").Response}
    * @param next {import("express").NextFunction}
    * @returns {Promise<void>}
    */
  async authorize(req, res, next) {
    // if (!req.headers.authorization) {
    //   res.status(401).set("www-authenticate", "Basic realm="MyRealm").end();
    // } else {
    //   // Validate req.headers.authorization
    //   next();
    // }
    next();
  }
  /**
   * Delete the repository, if supported  
   * @returns {Promise<void>}
   */
  async DeleteRepo() {
    throw new Error("Not Implemented");
  }
  /**
   * Get the list of branches in the repository. Same as <code>GetRefs</code>
   * @returns {Promise<{ref: string, sha: string}[]>}
   */
  async GetBranches() {
    var refs = await this.getRefs(null);
    return refs.map((ref) => ({ ref: ref.ref, sha: ref.sha }));
  }
  /**
   * Parse a tree object and return the list of files and directories
   * @param {any} tree tree object (get it with getObject)
   * @param {boolean} recursive enumerate all directories and files and add them as a subtree property on each tree entry
   * @returns {Promise<{mode: number, name: string, sha: string, subtree?: any[]}>}
   */
  async parseTree(tree, recursive) {
    if (tree.objectType != "tree") throw new Error(`${tree.sha} is not a tree. (${tree.objectType})`)
    const treedata = tree.data;
    const entries = [];
    let offset = 0;
    while (offset < treedata.length) {
      let spaceIndex = treedata.indexOf(" ", offset);
      let mode = parseInt(treedata.toString("utf8", offset, spaceIndex));
      offset = spaceIndex + 1;

      let nullIndex = treedata.indexOf("\0", offset);
      let filename = treedata.toString("utf8", offset, nullIndex);
      offset = nullIndex + 1;

      let sha1 = treedata.slice(offset, offset + 20).toString("hex");
      offset += 20;

      if (mode == 40000 && recursive == true) {
        try {
          const subobj = await this.getObject(undefined, sha1);
          const subtree = await this.parseTree(subobj, recursive)
          entries.push({ mode, name: filename, sha: sha1, subtree });
        } catch (error) {
          console.error(error.message);
        }
      } else {
        entries.push({ mode, name: filename, sha: sha1 });
      }
    }
    return entries;
  }
  /**
   * Parse a tag object and return the object, type, tagger and message
   * @param {any} tag tag object (get it with getObject)
   * @returns {object: string, type: string, tagger: string, message: string}
   */
  parseTag(tag) {
    if (tag.objectType != "tag") throw new Error(`${tag.sha} is not a tag. (${tag.objectType})`)
    const tagdata = tag.data.toString("utf8").split("\n");
    const object = tagdata[0].split(" ")[1];
    const type = tagdata[0].split(" ")[0];
    const tagger = tagdata[1].split(" ")[1];
    const message = tagdata.slice(2).join("\n");
    return { object, type, tagger, message };
  }
  /**
   * Parse a commit object and return the tree, parent, author, committer and message
   * @param {any} commit commit object (get it with getObject) 
   * @returns {tree: string, parent: string, author: string, committer: string, message: string}
   */
  parseCommit(commit) {
    if (commit.objectType != "commit") throw new Error(`${commit.sha}is not a commit. (${commit.objectType})`)
    const commitdata = commit.data.toString("utf8").split("\n");
    const tree = commitdata[0].split(" ")[1];
    const parent = commitdata[1].split(" ")[1];
    const author = commitdata[2].split(" ")[1];
    const committer = commitdata[3].split(" ")[1];
    const message = commitdata.slice(4).join("\n");
    return { tree, parent, author, committer, message };
  }
  /**
   * Get the list of files in a tree, sha can be a commit or a tree
   * @param {string} sha of the commit or tree
   * @param {boolean} recursive enumerate all directories and files and add them as a subtree property on each tree entry
   * @returns 
   */
  async GetTree(sha, recursive) {
    var commit = await this.getObject(null, sha);
    if (commit.objectType == "tree") {
      return await this.parseTree(commit, recursive);
    }
    if(commit.objectType == "tag") {
      var _tag = this.parseTag(commit);
      return await this.GetTree(_tag.object, recursive);
    }
    var _commit = this.parseCommit(commit);
    var tree = await this.getObject(null, _commit.tree);
    return await this.parseTree(tree, recursive);
  }
  /**
   * Get the list of refs (branches and tags) in the repository
   * @param req {import("express").Request}
   * @returns {Promise<{ref: string, sha: string}[]>}
   */
  async getRefs(req) {
    throw new Error("Not Implemented");
  }
  /**
   * Get the HEAD ref of the repository (default branch or current branch) 
   * @param req {import("express").Request}
   * @returns {Promise<string>}
   */
  async getHeadRef(req) {
    throw new Error("Not Implemented");
  }
  /**
   * Called when a client sends a pack of objects to the server
   * @param {import("express").Request}
   * @param {any[]} commands 
   * @param {any[]} objects 
   */
  async receivePack(req, commands, objects) {
    throw new Error("Not Implemented");
  }
  /**
   * Get an object from the repository
   * @param req {import("express").Request}
   * @param sha {string} sha of the object
   * @returns {Promise<{objectType: string, data: Buffer}>}
   */
  async getObject(req, sha) {
    throw new Error("Not Implemented");
  }
  /**
   * Override to set a custom message returned to the git client after a successful receive-pack operation, not all clients will display this message
   * @param {import("express").Request} req
   * @param {*} commands 
   * @param {*} objects 
   * @returns 
   */
  async getReceivePackSuccessMessage(req, commands, objects) {
    return `Received ${commands.length} ref${commands.length !== 1 ? "s" : ""} and ${objects.length} object${
      objects.length !== 1 ? "s" : ""
    }\n\n`;
  }
  /**
   * Override to set a custom message returned to the git client after a successful upload-pack operation, not all clients will display this message
   * @param {import("express").Request} req 
   * @param {*} objects 
   * @returns 
   */
  async getUploadPackSuccessMessage(req, objects) {
    if(objects != null && objects.length) return `ACK ${objects.length} objects\n`;
    return `ACK ok\n`;
  }
  _expressHandler;
  expressHandler(req, res, next) {
    var url = req.originalUrl;
    if(url.indexOf("?") > 0) {
      url = url.substring(0, url.indexOf("?"));
    }
    let parts = url.split("/");
    if(parts[parts.length - 1] == "info" || parts[parts.length - 2] == "info") {
      const _next = () => {
        return Protocol.handleGetRefs(this)(req, res, next)
      }
      this.authorize(req, res, _next);
    } else if(parts[parts.length - 1] == "git-upload-pack" || parts[parts.length - 1] == "git-receive-pack") {
      const _next = () => {
        return Protocol.handlePost(this, parts[parts.length - 1])(req, res, next);
      }
      this.authorize(req, res, _next);      
    } else {
      return next();
    }    
  }
  /**
   * Call to add a default route to the express app
   * @returns {import("express").Router}
   */
  createExpress(app, path) {
    if(this._expressHandler == null) {
      this._expressHandler = this.expressHandler.bind(this);
    }
    app.use(path, this._expressHandler);
    return app;
  }
  removeExpress(app, path) {
    app._router.stack = app._router.stack.filter((layer) => layer.handle !== this._expressHandler);
  }
  /**
   * Test if the request should be ignored
   * @param {import("express").Request} req 
   */
  ignoreRequest(req) {
    var url = req.originalUrl;
    if(url.indexOf("?") > 0) {
      url = url.substring(0, url.indexOf("?"));
    }
    let parts = url.split("/");
    if(parts[parts.length - 1] == "info" || parts[parts.length - 2] == "info") {
      return true;
    }
    if(parts[parts.length - 1] == "git-upload-pack" || parts[parts.length - 1] == "git-receive-pack") {
      return true;
    }
    return false;
  }    
}
