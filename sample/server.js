require('dotenv').config()

const Express = require('express');
const { MemoryGitRepository, MongoGitRepository, Protocol } = require('../lib');
const { MongoClient } = require('mongodb');

async function main() {
  const mongodburl = process.env.MONGO_URL || 'mongodb://localhost:27017';
  const mongodb = process.env.MONGO_DB || 'git';
  const mongocol = process.env.MONGO_COL || 'repos';
  const cli = await MongoClient.connect(mongodburl);
  
  const app = Express();
  const repos = {}

  app.use('/git*', async (req, res, next) => {
    try {
      var url = req.originalUrl;
      if(url.indexOf('?') > 0) {
        url = url.substring(0, url.indexOf('?'));
      }
      console.log(url);
      let parts = url.split('/');
      let path = parts[2];
      let repo = repos[path];
      if (repo == null && path != null && path != "") {
        // repo = new MemoryGitRepository();
        repo = new MongoGitRepository(cli.db(mongodb), mongocol, path);
        repos[path] = repo;
      }
      if(parts.length > 4 && parts[3] == "info" && parts[4] == "refs") {
        Protocol.handleGetRefs(repo)(req, res, next);
      } else if(parts.length > 3 && parts[3] == "git-upload-pack") {
        Protocol.handlePost(repo, 'git-upload-pack')(req, res, next);
      } else if(parts.length > 3 && parts[3] == "git-receive-pack") {
        Protocol.handlePost(repo, 'git-receive-pack')(req, res, next);
      } else if(parts.length == 2 || (parts.length == 3 && path == "")) {
        var _repos = await cli.db(mongodb).collection(mongocol).distinct('repo');
        var html = "<html><body><a href='/git'>repos</a><ul>";
        for(var i = 0; i < _repos.length; i++) {
          html += `<li><a href="/git/${_repos[i]}">${_repos[i]}</a>`;
          html += ` <a href="/git/${_repos[i]}/delete">del</a></li>`;
        }
        html += "</ul></body></html>"; 
        res.status(200).send(html);
        next();
      } else if(parts.length == 3) {
        var branches = await repo.GetBranches();
        branches.sort((a, b) => a.name.localeCompare(b.name));
        var html = "<html><body><a href='/git'>repos</a> | <a href='/git/"+path+"'>branches</a><ul>";
        for(let i = 0; i < branches.length; i++) {
          var ref = branches[i].name;
          if(ref == "HEAD") continue;
          html += `<li><a href="/git/${path}/${encodeURIComponent(ref)}">branch ${ref}</a></li>`;
        }
        html += "</ul></body></html>"; 
        res.status(200).send(html);
        next();
      } else if((parts.length == 4 && parts[3] != "delete") || parts.length == 5) {
        var ref = parts[3];
        if(parts.length == 4) {
          var html = "<html><body><a href='/git'>repos</a> | <a href='/git/"+path+"'>branches</a><ul>";
          var branches = await repo.GetBranches();
          var branch = branches.find(x => x.name == decodeURIComponent(parts[3]));
          if(branch == null) {
            return res.status(404).send('File not found');
          }
          var files = await repo.GetTree(branch.sha, false);
        } else {
          var html = "<html><body><a href='/git'>repos</a> | <a href='/git/"+path+"'>branches</a> | <a href='javascript:history.back()''>Go Back</a><ul>";
          var sha = parts[4];
          const file = await repo.db.collection(repo.repoName + '.files').findOne({ "filename": `blob_${sha}` });
          if (!file) {
            return res.status(404).send('File not found');
          }
          if(file.metadata.objectType == "tree" || file.metadata.objecttype == "tree") {
            var treeobj = await repo.getObject(null, sha);
            var files = await repo.parseTree(treeobj, false);
          } else {
            if(req.query.download != null){
              res.set({
                'Content-Type': file.contentType,
                'Content-Disposition': `attachment; filename="${file.filename}"`,
              });

              const downloadStream = repo.bucket.openDownloadStream(file._id);
              downloadStream.pipe(res);
              return res.end();
            }
            var treeobj = await repo.getObject(null, sha);
            var html = "<html><body><a href='/git'>repos</a> | <a href='/git/"+path+"'>branches</a> | <a href='javascript:history.back()''>Go Back</a>";
            html += "<p><pre>" + treeobj.data.toString('utf8') + "</p></pre>"
            html += "</ul></body></html>"; 
            res.status(200).send(html);
            next();
            return;
          }
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        for(let i = 0; i < files.length; i++) {
          const file = files[i]
          if(file.mode != 40000) continue;
          html += `<li><a href="/git/${path}/${ref}/${file.sha}">${file.name}</a></li>`;
        }
        let readme = "";
        for(let i = 0; i < files.length; i++) {
          const file = files[i]
          if(file.mode == 40000) continue;
          if(file.name.toLowerCase() == "readme.md") readme = (await repo.getObject(undefined, file.sha)).data.toString('utf8');
          html += `<li><a href="/git/${path}/${ref}/${file.sha}">${file.name}</a> | <a href="/git/${path}/${ref}/${file.sha}?download=${Math.random().toString(36).substring(7)}">download</a></li>`;
        }
        html += "</ul><p><pre>" + readme + "</pre></p></body></html>"; 
        res.status(200).send(html);
        next();
      } else if(parts.length == 4 && parts[3] == "delete") {
        await repo.DeleteRepo();
        res.status(200).send("Deleted<p><a href='/git'>back</p>");
        next();
      } else {
        console.log("Not Found", url);
        res.status(404).send('Not Found');
        next();
      }
    } catch (error) {
      console.error('error', url, error.message);
      res.status(500).send(`Internal Server Error: ${error.message}`);
      next();
    }
  });
  
  require('http')
    .createServer(app)
    .listen(3000, () => {
      console.log('Your git repositories are available at http://localhost:3000/git/');
    });
}
main();