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
const GitRepository = require('./GitRepository');
const { debug } = require('./protocol');

class MemoryGitRepository extends GitRepository {
  constructor() {
    super();
    // Starting from an empty repository
    this.refs = {};
    this.refsList = [];
    this.objects = {};
    this.headRef = undefined;
  }

  async DeleteRepo() {
    this.refs = {};
    this.refsList = [];
    this.objects = {};
    this.headRef = undefined;
  }
  
  async getRefs(req) {
    return this.refsList;
  }

  async getHeadRef(req) {
    return this.headRef;
  }

  async receivePack(req, commands, objects) {
    commands.forEach((command) => {
      if (this.isZeroId(command.destId)) {
        delete this.refs[command.ref];
      } else {
        this.refs[command.ref] = command.destId;
      }
    });
    this.refsList = Object.keys(this.refs)
      .sort()
      .map((ref) => ({ ref, sha: this.refs[ref] }));
    objects.forEach((object) => {
      this.objects[object.sha.toString('hex')] = {
        objectType: object.objectType,
        data: object.data,
      };
    });
    if (!this.refs['HEAD']) {
      ['master', 'main'].forEach(
        (b) => (this.headRef = this.refs[`refs/heads/${b}`] ? `refs/heads/${b}` : this.headRef)
      );
      if (this.headRef) {
        this.refs['HEAD'] = this.refs[this.headRef];
        this.refsList.unshift({ ref: 'HEAD', sha: this.refs['HEAD'] });
      }
    }
    debug('HEAD', this.headRef);
    debug('REFS', this.refs);
  }
  async getObject(req, sha) {
    if (!this.objects[sha]) {
      throw new Error(`Object ${sha} not found.`);
    }
    return this.objects[sha];
  }
}

module.exports = MemoryGitRepository;
