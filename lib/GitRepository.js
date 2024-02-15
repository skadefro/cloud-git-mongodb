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
const Protocol = require('./protocol');

class GitRepository {
  constructor() {}

  isZeroId(id) {
    return id === Protocol.ZeroIdStr;
  }

  async authorize(req, res, next) {
    // if (!req.headers.authorization) {
    //   res.status(401).set("www-authenticate", 'Basic realm="MyRealm').end();
    // } else {
    //   // Validate req.headers.authorization
    //   next();
    // }
    next();
  }

  async DeleteRepo() {
    throw new Error('Not Implemented');
  }

  async GetBranches() {
    var refs = await this.getRefs(null);
    return refs.map((ref) => ({ name: ref.ref, sha: ref.sha }));
  }

  async parseTree(tree, recursive) {
    if (tree.objectType != 'tree') throw new Error(`${tree.sha} is not a tree. (${tree.objectType})`)
    const treedata = tree.data;
    const entries = [];
    let offset = 0;
    while (offset < treedata.length) {
      let spaceIndex = treedata.indexOf(' ', offset);
      let mode = parseInt(treedata.toString('utf8', offset, spaceIndex));
      offset = spaceIndex + 1;

      let nullIndex = treedata.indexOf('\0', offset);
      let filename = treedata.toString('utf8', offset, nullIndex);
      offset = nullIndex + 1;

      let sha1 = treedata.slice(offset, offset + 20).toString('hex');
      offset += 20;

      if (mode == 40000 && recursive == true) {
        try {
          const subobj = await this.getObject(undefined, sha1);
          const subtree = await this.parseTree(subobj, false)
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
  parseCommit(commit) {
    if (commit.objectType != 'commit') throw new Error(`${commit.sha}is not a commit. (${commit.objectType})`)
    const commitdata = commit.data.toString('utf8').split('\n');
    const tree = commitdata[0].split(' ')[1];
    const parent = commitdata[1].split(' ')[1];
    const author = commitdata[2].split(' ')[1];
    const committer = commitdata[3].split(' ')[1];
    const message = commitdata.slice(4).join('\n');
    return { tree, parent, author, committer, message };
  }
  async GetTree(sha, recursive) {
    var commit = await this.getObject(null, sha);
    if (commit.objectType == 'tree') {
      return await this.parseTree(commit, recursive);
    }
    var _commit = this.parseCommit(commit);
    var tree = await this.getObject(null, _commit.tree);
    return await this.parseTree(tree, recursive);
  }

  async getRefs(req) {
    throw new Error('Not Implemented');
  }

  async getHeadRef(req) {
    throw new Error('Not Implemented');
  }

  async receivePack(req, commands, objects) {
    throw new Error('Not Implemented');
  }

  async getObject(req, ha) {
    throw new Error('Not Implemented');
  }

  async getReceivePackSuccessMessage(req, commands, objects) {
    return `Received ${commands.length} ref${commands.length !== 1 ? 's' : ''} and ${objects.length} object${
      objects.length !== 1 ? 's' : ''
    }\n\n`;
  }

  async getUploadPackSuccessMessage(req, objects) {
    if(objects != null && objects.length) return `ACK ${objects.length} objects\n`;
    return `ACK ok\n`;
  }

  createExpress(express) {
    const router = express.Router();

    router.get('/info/refs', this.authorize, Protocol.handleGetRefs(this));
    router.post('/git-upload-pack', this.authorize, Protocol.handlePost(this, 'git-upload-pack'));
    router.post('/git-receive-pack', this.authorize, Protocol.handlePost(this, 'git-receive-pack'));

    return router;
  }
}

module.exports = GitRepository;
