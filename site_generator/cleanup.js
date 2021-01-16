require('dotenv').config()
const fs = require('fs-extra')
const aws = require('./aws_lib')

const config = fs.readJsonSync('./output.json')

run()

async function run() {
    await aws.detach_policy(config.deploy.user_name, config.deploy.policy_arn)
    await aws.delete_access_key(config.deploy.user_name, config.deploy.access_key.id)
    await aws.delete_user(config.deploy.user_name)
    await aws.delete_policy(config.deploy.policy_arn)

    if(config.lambda.role_name && config.ses.send_policy_arn) {
        await aws.detach_role_policy(config.lambda.role_name, config.ses.send_policy_arn)
    }

    if(config.lambda.role_name) {
        await aws.detach_role_policy(config.lambda.role_name, 'arn:aws:iam::aws:policy/AWSLambdaExecute')
        await aws.delete_role(config.lambda.role_name)
    }

    await aws.delete_identity(`${config.PROJECT}.${config.DOMAIN}`)

    await aws.delete_bucket(`${config.PROJECT}.${config.DOMAIN}`)
}

