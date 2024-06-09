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
import { Protocol, tools } from "./index.mjs";

export class GitRepository {
  constructor() {}

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
   * Get the list of files in a tree, sha can be a commit or a tree
   * @param {string} sha of the commit or tree
   * @param {boolean} recursive enumerate all directories and files and add them as a subtree property on each tree entry
   * @returns 
   */
  async GetTree(sha, recursive) {
    const commit = await this.getObject(null, sha);
    let result;
    if (commit.objectType == "tree" || commit.objectType == 2) {
      result = await tools.parseTree(this, commit);
    } else if(commit.objectType == "tag" || commit.objectType == 4) {
      var _tag = tools.parseTag(commit);
      result = this.GetTree(_tag.object);
    } else {
      var _commit = tools.parseCommit(commit);
      var tree = await this.getObject(null, _commit.tree);
      result = await tools.parseTree(this, tree);
    }
    if(recursive) {
      for(let i = 0; i < result.length; i++) {
        if(result[i].mode == 40000 || result[i].mode == 16384) {
          result[i].subtree = await this.GetTree(result[i].sha, true);
        }
      }
    }
    return result;
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
        return Protocol.handleGetRefs(this, req, res, next)
      }
      this.authorize(req, res, _next);
    } else if(parts[parts.length - 1] == "git-upload-pack" || parts[parts.length - 1] == "git-receive-pack") {
      const _next = () => {
        return Protocol.handlePost(this, parts[parts.length - 1], req, res, next);
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
