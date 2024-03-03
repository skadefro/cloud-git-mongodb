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
import { Protocol, GitRepository } from "./index.mjs";

export class MemoryGitRepository extends GitRepository {
  refs = {};
  refsList = [];
  objects = {};
  headRef = undefined;
  constructor() {
    super();
    // Starting from an empty repository
    this.refs = {};
    this.refsList = [];
    this.objects = {};
    this.headRef = undefined;
  }
  /**
   * Release all resources used by repository.
   * @returns {Promise<void>}
   */
  async DeleteRepo() {
    this.refs = {};
    this.refsList = [];
    this.objects = {};
    this.headRef = undefined;
  }
    /**
   * Get the list of refs (branches and tags) in the repository
   * @param req {import("express").Request}
   * @returns {Promise<{ref: string, sha: string}[]>}
   */
  async getRefs(req) {
    return this.refsList;
  }
  /**
   * Get the HEAD ref of the repository (default branch or current branch) 
   * @param req {import("express").Request}
   * @returns {Promise<string>}
   */
  async getHeadRef(req) {
    return this.headRef;
  }
  /**
   * Called when a client sends a pack of objects to the server
   * @param {import("express").Request}
   * @param {any[]} commands 
   * @param {any[]} objects 
   */
  async receivePack(req, commands, objects) {
    commands.forEach((command) => {
      if(command.ref == null) {
        var b = true;
      } else if(command.command == "delete") {
        delete this.refs[command.ref];
      } else {
        this.refs[command.ref] = command.destId;
      }
    });
    this.refsList = Object.keys(this.refs)
      .sort()
      .map((ref) => ({ ref, sha: this.refs[ref] }));
    objects.forEach((object) => {
      this.objects[object.sha.toString("hex")] = {
        objectType: object.objectType,
        data: object.data,
      };
    });
    if (!this.refs["HEAD"]) {
      ["master", "main"].forEach(
        (b) => (this.headRef = this.refs[`refs/heads/${b}`] ? `refs/heads/${b}` : this.headRef)
      );
      if (this.headRef) {
        this.refs["HEAD"] = this.refs[this.headRef];
        this.refsList.unshift({ ref: "HEAD", sha: this.refs["HEAD"] });
      }
    }
    Protocol.debug("HEAD", this.headRef);
    Protocol.debug("REFS", this.refs);
  }
  /**
   * Get an object from the repository
   * @param req {import("express").Request}
   * @param sha {string} sha of the object
   * @returns {Promise<{objectType: string, data: Buffer}>}
   */
  async getObject(req, sha) {
    if (!this.objects[sha]) {
      console.log("ERROR: Object not found", sha);
      throw new Error(`Object ${sha} not found.`);
    }
    return this.objects[sha];
  }
}
