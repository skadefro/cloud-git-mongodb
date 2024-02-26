require("dotenv").config()

const Express = require("express");
// const { MemoryGitRepository, MongoGitRepository, Protocol } = require("../lib/index.mjs");
const { MongoClient } = require("mongodb");
const memoryrepo = false;
async function main() {
  try {
    const { MemoryGitRepository, MongoGitRepository, Protocol } = await import("../lib/index.mjs");


    const mongodburl = process.env.MONGO_URL || "mongodb://localhost:27017";
    const mongodb = process.env.MONGO_DB || "git";
    const mongocol = process.env.MONGO_COL || "repos";
    /**
     * @type {MongoClient}
    **/
    let cli = null;
    if(memoryrepo == false) {
      cli = await MongoClient.connect(mongodburl);
    }
    const app = Express();
    const repos = {}
    app.use("/git*", async (req, res, next) => {
      try {
        var url = req.originalUrl;
        if(url.indexOf("?") > 0) {
          url = url.substring(0, url.indexOf("?"));
        }
        console.log(req.method, url);
        let parts = url.split("/");
        let path = parts[2];
        let repo = repos[path];
        if (repo == null && path != null && path != "") {
          if(memoryrepo == true) {
            repo = new MemoryGitRepository();
          } else {
            repo = new MongoGitRepository(cli.db(mongodb), mongocol, path);
          }
          repo.createExpress(app, "/git/" + path);
          repos[path] = repo;
        }
        if(repo != null && repo.ignoreRequest(req)) {
          return next();
        } else if(parts.length == 2 || (parts.length == 3 && path == "")) {
          var html = `<html><body><a href="/git">repos</a><ul>`;
          var _repos = [];
          if(memoryrepo == false) {
            _repos = await cli.db(mongodb).collection(mongocol).distinct("repo");
            for(var i = 0; i < _repos.length; i++) {
              html += `<li><a href="/git/${_repos[i]}">${_repos[i]}</a>`;
              html += ` <a href="/git/${_repos[i]}/delete">del</a></li>`;
            }
          } else {
            var keys = Object.keys(repos);
            for(var i = 0; i < keys.length; i++) {
              const key = keys[i];
              if(_repos.indexOf(key) < 0) {
                html += `<li><a href="/git/${key}">${key}</a>`;
              }
            }
          }
          html += "</ul></body></html>"; 
          res.status(200).send(html);
          next();
        } else if(parts.length == 3) {
          var branches = await repo.GetBranches();
          branches.sort((a, b) => a.ref.localeCompare(b.ref));
          var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a><ul>`;
          for(let i = 0; i < branches.length; i++) {
            var ref = branches[i].ref;
            if(ref == "HEAD") continue;
            html += `<li><a href="/git/${path}/${encodeURIComponent(ref)}">branch ${ref}</a></li>`;
          }
          html += "</ul></body></html>"; 
          res.status(200).send(html);
          next();
        } else if((parts.length == 4 && parts[3] != "delete") || parts.length == 5) {
          var ref = parts[3];
          if(parts.length == 4) {
            var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a><ul>`;
            var branches = await repo.GetBranches();
            var branch = branches.find(x => x.ref == decodeURIComponent(parts[3]));
            if(branch == null) {
              return res.status(404).send("File not found");
            }
            var files = await repo.GetTree(branch.sha, false);
          } else {
            var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a> | <a href="javascript:history.back()"">Go Back</a><ul>`;
            var sha = parts[4];
            const file = await repo.getObject(null, sha);
            if (!file) {
              return res.status(404).send("File not found");
            }
            if(file.objectType == "tree" || file.objecttype == "tree") {
              var files = await repo.parseTree(file, false);
            } else {
              if(req.query.download != null){
                res.set({
                  "Content-Type": file.contentType,
                  "Content-Disposition": `attachment; filename="${sha}"`,
                });
                res.write(file.data);
                return res.end();
              }
              var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a> | <a href="javascript:history.back()"">Go Back</a>`;
              html += `<p><pre>${file.data.toString("utf8")}</p></pre>`
              html += `</ul></body></html>`;
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
            if(file.name.toLowerCase() == "readme.md") readme = (await repo.getObject(undefined, file.sha)).data.toString("utf8");
            html += `<li><a href="/git/${path}/${ref}/${file.sha}">${file.name}</a> | <a href="/git/${path}/${ref}/${file.sha}?download=${Math.random().toString(36).substring(7)}">download</a></li>`;
          }
          html += `</ul><p><pre>${readme}</pre></p></body></html>`;
          res.status(200).send(html);
          next();
        } else if(parts.length == 4 && parts[3] == "delete") {
          repo.removeExpress(app, path);
          await repo.DeleteRepo();
          res.status(200).send(`Deleted<p><a href="/git">back</p>`);
          delete repos[path];
          next();
        } else {
          console.log("Not Found", url);
          res.status(404).send("Not Found");
          next();
        }
      } catch (error) {
        console.error("error", url, error.message);
        res.status(500).send(`Internal Server Error: ${error.message}`);
        next();
      }
    });
    
    const server = require("http")
      .createServer(app)
      .listen(3000, () => {
        console.log("Your git repositories are available at http://localhost:3000/git/");
      });
      
      // timeout work around.
      // parsing packages is brain-dead slow ... it takes FOREVER if a client is pushing a big file.
      // update: ok, found a work around by only parsing pack once client has sent it all.
      // but leaving this here just in case.
      server.timeout = 240000 * 10; // Set timeout to 40 minutes
      server.keepAliveTimeout = 240000 * 10; // Increase keep-alive timeout to match server timeout
      server.headersTimeout = server.keepAliveTimeout + 1000; // Slightly longer than keepAliveTimeout    
  } catch (error) {
    console.error("error", error.message);    
  }
}
main();