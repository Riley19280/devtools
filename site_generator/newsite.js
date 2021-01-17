require('dotenv').config()
const fs = require('fs-extra')
const inquirer = require('inquirer')
const path = require('path')
const aws = require('./aws_lib')
const child_process = require('child_process')
const fetch = require('node-fetch')
const clf = require('./cloudflare_lib')
const nch = require('./namecheap_lib')

let CREATE_LAMBDA_INFRASTRUCTURE = false
let CREATE_SES_INFRASTRUCTURE = false
let PROJECT
let DOMAIN
let BUCKET_INDEX_DOCUMENT
let BUCKET_ERROR_DOCUMENT
let MAIL_FROM_DOMAIN_PREFIX
let NAMECHEAP_NAMESERVER_UPDATE = false
let CLOUDFLARE_SETUP = false
let PROJECT_SETUP = true
let GITHUB_SETUP = true

let OUTPUT

async function run() {
    await getInput()
    OUTPUT = {
        PROJECT,
        DOMAIN,
        deploy: {},
        lambda: {},
        ses: {}
    }
    console.log(`Creating AWS user ${PROJECT}-deploy`)
    let user = await aws.create_user(`${PROJECT}-deploy`, PROJECT)
    let document = await create_policy_document('s3-deploy-perms.json', {PROJECT, DOMAIN})
    console.log(`Creating AWS policy ${PROJECT}-s3`)
    let policy = await aws.create_policy(`${PROJECT}-s3`, document)

    OUTPUT.deploy = {
        ...OUTPUT.deploy,
        policy_arn: policy.Policy.Arn,
        user_arn: user.User.Arn,
        user_name: user.User.UserName,
        user_id: user.User.UserId,
        access_key: {
            id: user.User.AccessKeyId,
            secret: user.User.SecretAccessKey
        }
    }

    await aws.attach_policy(user.User.UserName, policy.Policy.Arn)

    if(CREATE_LAMBDA_INFRASTRUCTURE) {
        let document = await create_policy_document('lambda-execution-role.json', {})
        console.log(`Creating aws role ${PROJECT}-lambda`)
        let role = await aws.create_role(`${PROJECT}-lambda`, document, PROJECT)

        await aws.attach_role_policy(role.Role.RoleName, 'arn:aws:iam::aws:policy/AWSLambdaExecute')

        OUTPUT.lambda = {
            ...OUTPUT.lambda,
            role_arn: role.Role.Arn,
            role_name: role.Role.RoleName,
        }

        if(CREATE_SES_INFRASTRUCTURE) {
            let document = await create_policy_document('ses-send-perms.json', { PROJECT, DOMAIN, EMAIL_NAME: 'test'})
            console.log(`Creating AWS policy ${PROJECT}-ses-send`)
            let policy = await aws.create_policy(`${PROJECT}-ses-send`, document)
            await aws.attach_role_policy(role.Role.RoleName, policy.Policy.Arn)

            OUTPUT.ses = {
                ...OUTPUT.ses,
                send_policy_arn: policy.Policy.Arn
            }
        }
    }

    let dns_records = []



    if(CREATE_SES_INFRASTRUCTURE) {
        console.log(`Creating domain verification records`)
        let verify = await aws.verify_domain_identity(`${PROJECT}.${DOMAIN}`)
        dns_records.push(aws.util.get_txt_from_verificaton(verify.VerificationToken, `${PROJECT}.${DOMAIN}`))

        console.log(`Creating domain dkim records`)
        let dkim = await aws.verify_domain_dkim(`${PROJECT}.${DOMAIN}`)
        for(let tok of dkim.DkimTokens) {
            dns_records.push(aws.util.get_cname_from_dkim(tok, `${PROJECT}.${DOMAIN}`))
        }

        console.log(`Setting domain mail from address`)
        await aws.set_mail_from_domain(`${PROJECT}.${DOMAIN}`, `${MAIL_FROM_DOMAIN_PREFIX}.${PROJECT}.${DOMAIN}`)

        dns_records.push({
            name: `${MAIL_FROM_DOMAIN_PREFIX}.${PROJECT}.${DOMAIN}`,
            type: 'MX',
            value: 'feedback-smtp.us-east-1.amazonses.com',
            priority: 10
        })
        dns_records.push({
            name: `${MAIL_FROM_DOMAIN_PREFIX}.${PROJECT}.${DOMAIN}`,
            type: 'TXT',
            value: '"v=spf1 include:amazonses.com ~all"'
        })
    }

    let bucket_name = `${PROJECT}.${DOMAIN}`
    console.log(`Creating AWS S3 bucket ${bucket_name}`)
    await aws.create_bucket(bucket_name)
    await aws.put_bucket_website(bucket_name, 'index', 'error')
    await aws.put_bucket_policy(bucket_name, create_policy_document('s3-site-access-perms.json', { PROJECT, DOMAIN}))
    await aws.put_bucket_tagging(bucket_name, PROJECT)

    dns_records.push({
        name: `${PROJECT}.${DOMAIN}`,
        type: 'CNAME',
        value: `${PROJECT}.${DOMAIN}.s3-website-us-east-1.amazonaws.com`,
        proxied: true
    })

    OUTPUT.dns_records = dns_records

    if(CLOUDFLARE_SETUP) {
        let data = await clf.initialize_domain(`${PROJECT}.${DOMAIN}`, dns_records)
        OUTPUT.cloudflare = data
    }

    if(GITHUB_SETUP) {
        let resp = fetch(`https://api.github.com/user/repos`, {
            method: 'post',
            body: JSON.stringify({
                'name': PROJECT,
                'private': true,
            }),
            headers: {
                'Authorization': `token ${process.env.GITHUB_KEY}`,
            }
        })
            .then(res => res.json())
            .then(res => {
                if(!res.id) {
                    console.error(res)
                    return null
                }

                OUTPUT.github = {
                    name: res.name,
                    url: res.html_url,
                    clone: res.clone_url,
                }
                console.log(`Created GitHub repo ${res.name} -> ${res.html_url}`)

            })
    }

    if(PROJECT_SETUP) {
        let p = path.join(process.env.PROJECT_LOCATIONS, PROJECT)
        fs.ensureDir(p)
        console.log(`Cloning and installing project ${process.env.DEFAULT_PROJECT_URL}`)
        await exec_cmd(`cd ${p} && git clone ${process.env.DEFAULT_PROJECT_URL} . && rm -rf .git && npm install`)

        if(GITHUB_SETUP) {
            console.log('Initializing git repository and pushing..')
            await exec_cmd(`cd ${p} && git init && git add -A && git commit -m 'Initial Commit' && git remote add origin ${OUTPUT.github.clone} && git push --set-upstream origin master`)
        }

        await exec_cmd(`${process.env.EDITOR_PATH} ${p}`)
    }

    await write_output()
}


run()

function getInput(real=true) {
    if(!real) {
        CREATE_LAMBDA_INFRASTRUCTURE = true
        CREATE_SES_INFRASTRUCTURE = true
        PROJECT = 'test-project-998877'
        DOMAIN = 'com'
        BUCKET_INDEX_DOCUMENT = 'index'
        BUCKET_ERROR_DOCUMENT = 'error'
        MAIL_FROM_DOMAIN_PREFIX = 'mail'
        return new Promise((res, rej) => { res()})
    }

    let project_prompt =  {
            name: 'project',
            type: 'input',
            message: 'Project name:',
            validate: (name) => name != null && name.length > 0 ? true : 'Project name must be provided.'
        }

    let domain_prompt = {
        name: 'domain',
        type: 'input',
        message: 'Domain:',
        default: 'com',
        validate: (name) => name != null && name.length > 0 ? true : 'Domain must be provided.'
    }

    let bucket_index_doc_prompt = {
        name: 'bucket_index_document',
        type: 'input',
        message: 'Index document:',
        default: 'index',
        validate: (name) => name != null && name.length > 0 ? true : 'Index document must be provided.'
    }

    let bucket_error_doc_prompt = {
        name: 'bucket_error_document',
        type: 'input',
        message: 'Error document:',
        default: 'error',
        validate: (name) => name != null && name.length > 0 ? true : 'Error document must be provided.'
    }

    let lambda_prompt = {
        name: 'lambda',
        type: 'confirm',
        message: 'Create lambda execution role?',
    }

    let ses_prompt = {
        name: 'ses',
        type: 'confirm',
        message: 'Configure SES?',
    }

    let mail_from_prefix_prompt = {
        name: 'mail_from_prefix',
        type: 'input',
        message: 'Mail from domain prefix:',
        default: 'mail',
        validate: (name) => name != null && name.length > 0 ? true : 'Mail from name must be provided.'
    }

    let cloudflare_dns_setup_prompt = {
        name: 'cloudflare_dns',
        type: 'confirm',
        message: 'Configure site for cloudflare?',
    }

    let namecheap_nameservers_prompt = {
        name: 'namecheap_nameservers',
        type: 'confirm',
        message: 'Update namecheap nameservers?',
    }

    let github_repo_prompt = {
        name: 'create_github_repo',
        type: 'confirm',
        message: 'Initialize the github repo?',
    }

    let create_project_prompt = {
        name: 'create_default_project',
        type: 'confirm',
        message: 'Initialize the project with a default template?',
    }

    return inquirer
        .prompt([
            project_prompt,
            domain_prompt,
            github_repo_prompt,
            create_project_prompt,
            bucket_index_doc_prompt,
            bucket_error_doc_prompt,
            lambda_prompt,
            ses_prompt,
            cloudflare_dns_setup_prompt,
            namecheap_nameservers_prompt
        ])
        .then((answer) => {
            CREATE_LAMBDA_INFRASTRUCTURE = answer.lambda
            CREATE_SES_INFRASTRUCTURE = answer.ses
            PROJECT = answer.project
            DOMAIN = answer.domain
            BUCKET_INDEX_DOCUMENT = answer.bucket_index_document
            BUCKET_ERROR_DOCUMENT = answer.bucket_error_document

            CLOUDFLARE_SETUP = answer.cloudflare_dns
            NAMECHEAP_NAMESERVER_UPDATE = answer.namecheap_nameservers

            GITHUB_SETUP = answer.create_github_repo
            PROJECT_SETUP = answer.create_default_project

            if(answer.ses) {
                return inquirer.prompt(mail_from_prefix_prompt).then(answer => {
                    MAIL_FROM_DOMAIN_PREFIX = answer.mail_from_prefix
                })
            }
        });
}

function create_policy_document (filename, data) {
    let policy = fs.readFileSync(path.join(__dirname, 'policies', filename)).toString()

    return  replace_params(policy, data)
}

function replace_params(data, params) {
    for (const [k, v] of Object.entries(params)) {
        data = data.replace(new RegExp(`\\$${k}`, 'g'), v)
    }
    return data
}

function exec_cmd(cmd) {
    return new Promise(async (resolve, reject) => {
        child_process.exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                resolve(stdout)
            }
        })
    })
}


function write_output() {
    console.log(`Writing output file ${PROJECT}.json`)
    return fs.writeJsonSync(`${PROJECT}.json`, OUTPUT, {spaces: 4})
}