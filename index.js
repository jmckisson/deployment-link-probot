let application
const _ = require("lodash")
const request = require("request-promise-native")

///////////////////////////////////////////////
// Utility functions for comments
///////////////////////////////////////////////
const createDeploymentComment = async context => {
  if(context.payload.action !== "opened") {
    return;
  }
  const body = getCommentTemplate(context.payload.pull_request.title);
  // GitHub's API handles comments to PRs as issues to issues, so we use the issue context here.
  const prComment = context.issue({body: body});
  await context.octokit.issues.createComment(prComment);
}

const getCommentTemplate = title => 
  "Hey there! Thanks for helping Mudlet improve. :star2:\n\n" +
  "## Test versions\n\n" +
  "You can directly test the changes here:\n" +
  "- linux: (download pending, check back soon!)\n" +
  "- osx: (download pending, check back soon!)\n" +
  "- windows: (download pending, check back soon!)\n\n" +
  "No need to install anything - just unzip and run.\n" +
  "Let us know if it works well, and if it doesn't, please give details.\n" +
  (title === "New Crowdin updates"
  ? "\n" +
    "## Translation stats\n\n" +
    "calculation pending, check back soon!\n\n"
  : "");

const getDeploymentComment = async (repositoryOwner, repositoryName, prNumber, github) => {
  application.log("retrieving comments...")
  const commentAnswer = await github.issues.listComments({
    owner: repositoryOwner,
    repo: repositoryName,
    issue_number: prNumber
  })
  return _.find(commentAnswer.data, comment => comment.user.login === "add-deployment-links[bot]")
}

const updateDeploymentCommentBody = async (repoOwner, repoName, comment, github) => {
  application.log("Setting new comment body to:")
  application.log(comment.body)
  await github.issues.updateComment({
    owner: repoOwner,
    repo: repoName,
    comment_id: comment.id,
    body: comment.body
  })
}

///////////////////////////////////////////////
// appveyor utility functions
///////////////////////////////////////////////
const getPrNumberFromAppveyor = async (repositoryOwner, repositoryName, buildId) => {
  const response = await request(`https://ci.appveyor.com/api/projects/${repositoryOwner}/${repositoryName.toLowerCase()}/builds/${buildId}`);
  const builds = JSON.parse(response)
  return builds.build.pullRequestId
}

///////////////////////////////////////////////
// testing link functions
///////////////////////////////////////////////
const translatePlatform = platform => {
  if(platform === "macos"){
    return "osx"
  }
  return platform
}

const getMudletSnapshotLinksForPr = async prNumber => {
  const apiResponse = await request.get(`https://make.mudlet.org/snapshots/json.php?prid=${prNumber}`)
  const allPrLinks = JSON.parse(apiResponse).data
  
  if(typeof allPrLinks !== "object"){
    // we probably got an error here, so return an empty array
    return [];
  }
  // let's go crazy with functional programming, shall we?
  const latestLinks = _.chain(allPrLinks)
    // we use a different encoding for macOS, so we need to change it
    .map(value => {
      return {...value, platform: translatePlatform(value.platform)}
    })
    // now categorize them by OS
    .reduce((result, value) => {
      result[value.platform].push(value)
      return result
    }, {windows:[], linux: [], osx:[]})
    // now sort each OS by the creation_time (descending)
    .mapValues(value => value.sort((first, second) => {
      if(first.creation_time === second.creation_time){
        return 0
      } else if (first.creation_time < second.creation_time) {
        return 1
      } else {
        return -1
      }
    }))
    // now take the latest link
    .mapValues(value => value[0])
    // flatten the object into an array
    .reduce((result, value) => {
      result.push(value)
      return result
    }, [])
    // remove undefined values
    .filter(value => value !== undefined)
    .value()
  return latestLinks
}

const updateCommentUrl = (os, link, comment) => {
  comment.body = comment.body.replace(new RegExp(`- ${os}: .+`), `- ${os}: ${link}`)
}

const setDeploymentLinks = async (repositoryOwner, repositoryName, prNumber, github) =>{
  
  if(prNumber === undefined){
    return
  }
  
  application.log("Running for: " + prNumber)
  const links = await getMudletSnapshotLinksForPr(prNumber)
  const deploymentComment = await getDeploymentComment(repositoryOwner, repositoryName, prNumber, github)
  for(const pair of links){
    updateCommentUrl(pair.platform, pair.url, deploymentComment)
  }
  application.log("New deployment body:")
  application.log(deploymentComment.body)
  updateDeploymentCommentBody(repositoryOwner, repositoryName, deploymentComment, github)
}

///////////////////////////////////////////////
// functions for creating the translation statistics
///////////////////////////////////////////////
const translationStatRegex = /^\[\d{2}:\d{2}:\d{2}\]\s*\*?\s*(?<language>\w{2}_\w{2})\s*(?<translated>\d+)\s*(?<untranslated>\d+)\s*\d+\s*\d+\s*\d+\s*(?<percentage>\d+)%$/gm
const translationStatReplacementRegex = new RegExp("## Translation stats[^#]+", "gm")

const getPassedAppveyorJobs = async (targetUrl, repositoryOwner, repositoryName) => {
  const matches = targetUrl.match("/builds/(\\d+)")
  const buildId = matches[1]
  application.log("Build ID: " + buildId)
  const response = await request(`https://ci.appveyor.com/api/projects/${repositoryOwner}/${repositoryName.toLowerCase()}/builds/${buildId}`);
  const builds = JSON.parse(response)
  const passedJobs = _.filter(builds.build.jobs, element => element.status === "success")
  return passedJobs
}

const getAppveyorLog = async job => await request(`https://ci.appveyor.com/api/buildjobs/${job.jobId}/log`)

const getTranslationStatsFromAppveyor = async (githubStatusPayload) => {

  application.log("getting passed jobs")
  const passedJobs= await getPassedAppveyorJobs(
    githubStatusPayload.target_url,
    githubStatusPayload.repository.owner.login,
    githubStatusPayload.repository.name
  )

  if(passedJobs.length === 0){
    return {}
  }

  const log = await getAppveyorLog(passedJobs[0])

  let translationMatches
  const translationStats = {}
  while((translationMatches = translationStatRegex.exec(log)) !== null){
    translationStats[translationMatches.groups.language] = {
      translated: translationMatches.groups.translated,
      untranslated: translationMatches.groups.untranslated,
      percentage: translationMatches.groups.percentage,
    }
  }

  return translationStats
}

const buildTranslationTable = translationStats => {
  let output = "## Translation stats\n\n"
  output += "|language|translated|untranslated|percentage done|\n"
  output += "|--------|----------|------------|---------------|\n"
  for(const language of Object.keys(translationStats).sort()){
    output += `|${language}|${translationStats[language].translated}|${translationStats[language].untranslated}|${translationStats[language].percentage}|\n`
  }
  output += "\n"
  return output
}

const createTranslationStatistics = async (github, githubStatusPayload) => {
  if(githubStatusPayload.context.includes("pr")){
    const prNumber = await getPrNumberFromAppveyor(
      githubStatusPayload.repository.owner.login,
      githubStatusPayload.repository.name,
      githubStatusPayload.target_url.match("/builds/(\\d+)")[1]
    )
    const translationStats = await getTranslationStatsFromAppveyor(githubStatusPayload)

    if(Object.keys(translationStats).length === 0){
      application.log("No translation stats found, aborting")
      return
    }
    const output = buildTranslationTable(translationStats)

    const comment = await getDeploymentComment(
      githubStatusPayload.repository.owner.login,
      githubStatusPayload.repository.name,
      prNumber,
      github
    )

    if(!comment) {
      application.log("Couldn't find our comment, aborting")
      return
    }

    comment.body = comment.body.replace(translationStatReplacementRegex, output)  // on non-translation PRs, this doesn't replace anything as the block is not added
    updateDeploymentCommentBody(
      githubStatusPayload.repository.owner.login,
      githubStatusPayload.repository.name,
      comment,
      github
    )
  }
}

///////////////////////////////////////////////
// functions for handling pingbacks from the snapshots service
///////////////////////////////////////////////

const newSnapshotHandler = async (request, response) => {
    
  if(!validateRequest(request)){
    response.status(400).send('Bad Request: missing parameters');
    return;
  }
  
  const owner = request.query.owner;
  const repo = request.query.repo;

  const appOctokit = await application.auth();
  const installation = await getInstallation(appOctokit, owner, repo, response);
  if(installation === undefined){
    return;
  }
  
  const installationOctokit = await application.auth(installation.id);
  
  for (const prNumber of request.body){
    await setDeploymentLinks(owner, repo, prNumber, installationOctokit)
  };
  
  response.status(204).send();
}

const validateRequest = request => {
  return request.query.owner !== undefined && request.query.repo !== undefined;
}

const getInstallation = async (octokit, owner, repo, response) => {
  try{
    return (await octokit.apps.getRepoInstallation({owner, repo})).data;
  }catch(exception){
    if(exception.status === 404){
      response.status(404).send('app not installed to given owner and repository');
    }else{
      application.log(exception);
      response.status(500).send(`Unknown response from GitHub API: ${exception.headers.status}`);
    }
    return undefined;
  }
}

///////////////////////////////////////////////
// entrypoint
///////////////////////////////////////////////
module.exports = (app, {getRouter}) => {
  application = app
  // trigger to create a new deployment comment
  app.on("pull_request", createDeploymentComment)

  // trigger for appveyor builds. We pull the translation statistics from those and we use it as a trigger to scrape https://make.mudlet.org/snapshots
  app.on("status", async context => {
    if(!context.payload.context.includes("pr") && !context.payload.context.includes("appveyor")){
      return
    }
    await createTranslationStatistics(context.octokit, context.payload)
    await setDeploymentLinks( 
      context.payload.repository.owner.login,
      context.payload.repository.name,
      await getPrNumberFromAppveyor(
        context.payload.repository.owner.login,
        context.payload.repository.name,
        context.payload.target_url.match("/builds/(\\d+)")[1]
      ),
      context.octokit)
  })

  app.on("issue_comment", async context => {
    if(context.payload.action !== "created"){
      return
    }

    if(context.payload.comment.body !== "/refresh links"){
      return
    }

    await setDeploymentLinks(
      context.payload.repository.owner.login,
      context.payload.repository.name,
      context.payload.issue.number,
      context.octokit)
  })
  
  const router = getRouter('/snapshots');
  
  router.use(require("express").json());
  
  router.post('/new', newSnapshotHandler)
}
