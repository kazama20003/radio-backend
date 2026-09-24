import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RegisterDeviceDto,
  UpdateAppSettingDto,
  UpdateNotificationPrefDto,
} from './dto/preferences.dto';
import { PreferencesService } from './preferences.service';

@ApiTags('preferences')
@ApiBearerAuth()
@Controller()
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('notifications/preferences')
  getNotificationPref(@CurrentUser('id') userId: string) {
    return this.preferences.getNotificationPref(userId);
  }

  @Patch('notifications/preferences')
  updateNotificationPref(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNotificationPrefDto,
  ) {
    return this.preferences.updateNotificationPref(userId, dto);
  }

  @Post('notifications/devices')
  registerDevice(
    @CurrentUser('id') userId: string,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.preferences.registerDevice(userId, dto);
  }

  @Delete('notifications/devices/:token')
  removeDevice(
    @CurrentUser('id') userId: string,
    @Param('token') token: string,
  ) {
    return this.preferences.removeDevice(userId, token);
  }

  @Get('settings')
  getAppSetting(@CurrentUser('id') userId: string) {
    return this.preferences.getAppSetting(userId);
  }

  @Patch('settings')
  updateAppSetting(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateAppSettingDto,
  ) {
    return this.preferences.updateAppSetting(userId, dto);
  }
}
