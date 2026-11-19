import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { GitHubController } from './github/github.controller.js';
import { GitHubService } from './github/github.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController, GitHubController],
  providers: [GitHubService],
})
export class AppModule {}
