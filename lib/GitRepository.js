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
    throw new Error('Not Implemented');
  }

  async GetTree(sha) {
    throw new Error('Not Implemented');
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
